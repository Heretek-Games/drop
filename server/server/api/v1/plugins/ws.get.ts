import pluginManager from "~/server/internal/plugins";
import { resolvePluginAuth } from "~/server/internal/plugins/auth";

const clientSubscriptions = new Map<string, Array<() => void>>();
const clientChannels = new Map<string, Set<string>>();
const peerUsers = new Map<string, string | undefined>();
const peerAcls = new Map<string, string[] | undefined>();

/** Channels readable without authentication. Everything else needs a user. */
const PUBLIC_CHANNELS = new Set(["gse:rooms"]);
const CHANNEL_PATTERN = /^[a-zA-Z0-9:_-]{1,128}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SUBSCRIPTIONS_PER_PEER = 32;

/** Minimal structural view of the crossws peer used by the helpers below. */
type WebSocketPeer = {
  id: string;
  request: {
    headers: Headers;
  };
  send: (payload: string) => void;
  close: () => void;
};

interface ClientMessage {
  type?: unknown;
  channel?: unknown;
  data?: unknown;
}

function parseClientMessage(message: unknown): ClientMessage | undefined {
  const text =
    typeof (message as { text?: () => string }).text === "function"
      ? (message as { text: () => string }).text()
      : String(message);
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as ClientMessage;
    }
  } catch {
    // Ignore non-JSON messages.
  }
  return undefined;
}

/** Hosts an Origin must match for a browser upgrade. */
function allowedHostsFor(peer: WebSocketPeer): Set<string> {
  const allowedHosts = new Set<string>();
  const host = peer.request.headers.get("host");
  if (host) allowedHosts.add(host);
  const forwardedHost = peer.request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    for (const item of forwardedHost.split(",")) {
      const trimmed = item.trim();
      if (trimmed) allowedHosts.add(trimmed);
    }
  }
  const externalUrl = process.env.EXTERNAL_URL;
  if (externalUrl) {
    try {
      allowedHosts.add(new URL(externalUrl).host);
    } catch {
      // Ignore malformed configuration here; auth still applies below.
    }
  }
  return allowedHosts;
}

// Browsers always send Origin on WebSocket handshakes. Reject cross-site
// upgrades so a malicious page cannot ride a victim's session cookie into the
// plugin gateway (non-browser clients omit Origin and are allowed).
function isAllowedOrigin(peer: WebSocketPeer): boolean {
  const origin = peer.request.headers.get("origin");
  if (!origin) return true;

  const allowedHosts = allowedHostsFor(peer);
  let originHost: string | undefined;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = undefined;
  }
  return (
    !!originHost && (allowedHosts.size === 0 || allowedHosts.has(originHost))
  );
}

async function resolvePeerAuth(
  peer: WebSocketPeer,
): Promise<{ userId: string | undefined; userAcls: string[] | undefined }> {
  try {
    const auth = await resolvePluginAuth(peer.request);
    return { userId: auth.userId, userAcls: auth.userAcls };
  } catch {
    // Unauthenticated peer.
    return { userId: undefined, userAcls: undefined };
  }
}

function sendChannelError(
  peer: WebSocketPeer,
  channel: string,
  error: string,
): void {
  peer.send(JSON.stringify({ channel, error }));
}

async function authorizeChannel(
  peer: WebSocketPeer,
  channel: string,
  userId: string | undefined,
): Promise<boolean> {
  if (!userId && !PUBLIC_CHANNELS.has(channel)) {
    sendChannelError(peer, channel, "authentication required");
    return false;
  }

  // Per-channel authorization (e.g. room membership), when a plugin registers
  // an authorizer for the channel.
  const authorized = await pluginManager.canSubscribe(channel, {
    userId,
    userAcls: peerAcls.get(peer.id),
  });
  if (!authorized) {
    sendChannelError(peer, channel, "not authorized for channel");
    return false;
  }
  return true;
}

function handleSubscribe(peer: WebSocketPeer, channel: string): void {
  const subscriptions = clientChannels.get(peer.id);
  if (!subscriptions || subscriptions.has(channel)) return;
  if (subscriptions.size >= MAX_SUBSCRIPTIONS_PER_PEER) {
    sendChannelError(peer, channel, "too many subscriptions");
    return;
  }
  subscriptions.add(channel);

  const unsubscribe = pluginManager.subscribe(channel, (event) => {
    peer.send(JSON.stringify({ channel, data: event }));
  });
  clientSubscriptions.get(peer.id)?.push(unsubscribe);
}

async function dispatchClientMessage(
  peer: WebSocketPeer,
  channel: string,
  data: unknown,
  userId: string | undefined,
): Promise<void> {
  // Unauthenticated peers may only send on public channels.
  if (!userId && !PUBLIC_CHANNELS.has(channel)) {
    sendChannelError(peer, channel, "authentication required");
    return;
  }
  const handled = await pluginManager.dispatchWebSocket(channel, data, {
    userId,
    userAcls: peerAcls.get(peer.id),
    send: (payload) => peer.send(JSON.stringify({ channel, data: payload })),
  });
  if (!handled) {
    sendChannelError(peer, channel, "no plugin handler for channel");
  }
}

export default defineWebSocketHandler({
  async open(peer) {
    if (!isAllowedOrigin(peer)) {
      peer.close();
      return;
    }

    clientSubscriptions.set(peer.id, []);
    clientChannels.set(peer.id, new Set());

    // Authenticate the upgrade request so plugins receive a userId. Supports
    // both browser sessions/API tokens and desktop client JWTs.
    const { userId, userAcls } = await resolvePeerAuth(peer);
    peerUsers.set(peer.id, userId);
    peerAcls.set(peer.id, userAcls);
  },
  async message(peer, message) {
    try {
      const parsed = parseClientMessage(message);
      if (
        !parsed ||
        typeof parsed.channel !== "string" ||
        !CHANNEL_PATTERN.test(parsed.channel)
      ) {
        return;
      }
      const userId = peerUsers.get(peer.id);

      if (parsed.type === "subscribe") {
        if (!(await authorizeChannel(peer, parsed.channel, userId))) return;
        handleSubscribe(peer, parsed.channel);
        return;
      }

      if (parsed.type === "message") {
        await dispatchClientMessage(peer, parsed.channel, parsed.data, userId);
      }
    } catch {
      // Ignore non-JSON or invalid messages
    }
  },
  close(peer) {
    const unsubscribes = clientSubscriptions.get(peer.id);
    if (unsubscribes) {
      for (const unsub of unsubscribes) {
        unsub();
      }
      clientSubscriptions.delete(peer.id);
    }
    clientChannels.delete(peer.id);
    peerUsers.delete(peer.id);
    peerAcls.delete(peer.id);
  },
});
