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

export default defineWebSocketHandler({
  async open(peer) {
    clientSubscriptions.set(peer.id, []);
    clientChannels.set(peer.id, new Set());

    // Authenticate the upgrade request so plugins receive a userId. Supports
    // both browser sessions/API tokens and desktop client JWTs.
    let userId: string | undefined;
    let userAcls: string[] | undefined;
    try {
      const auth = await resolvePluginAuth(peer.request);
      userId = auth.userId;
      userAcls = auth.userAcls;
    } catch {
      // Unauthenticated peer.
    }
    peerUsers.set(peer.id, userId);
    peerAcls.set(peer.id, userAcls);
  },
  async message(peer, message) {
    try {
      const text =
        typeof message.text === "function" ? message.text() : String(message);
      if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
        return;
      }
      const data = JSON.parse(text);
      const userId = peerUsers.get(peer.id);

      if (
        data.type === "subscribe" &&
        typeof data.channel === "string" &&
        CHANNEL_PATTERN.test(data.channel)
      ) {
        if (!userId && !PUBLIC_CHANNELS.has(data.channel)) {
          peer.send(
            JSON.stringify({
              channel: data.channel,
              error: "authentication required",
            }),
          );
          return;
        }

        const subscriptions = clientChannels.get(peer.id);
        if (!subscriptions) return;
        if (subscriptions.has(data.channel)) return;
        if (subscriptions.size >= MAX_SUBSCRIPTIONS_PER_PEER) {
          peer.send(
            JSON.stringify({
              channel: data.channel,
              error: "too many subscriptions",
            }),
          );
          return;
        }
        subscriptions.add(data.channel);

        const unsubscribe = pluginManager.subscribe(data.channel, (event) => {
          peer.send(JSON.stringify({ channel: data.channel, data: event }));
        });
        clientSubscriptions.get(peer.id)?.push(unsubscribe);
        return;
      }

      if (
        data.type === "message" &&
        typeof data.channel === "string" &&
        CHANNEL_PATTERN.test(data.channel)
      ) {
        const handled = await pluginManager.dispatchWebSocket(
          data.channel,
          data.data,
          {
            userId,
            userAcls: peerAcls.get(peer.id),
            send: (payload) =>
              peer.send(
                JSON.stringify({ channel: data.channel, data: payload }),
              ),
          },
        );
        if (!handled) {
          peer.send(
            JSON.stringify({
              channel: data.channel,
              error: "no plugin handler for channel",
            }),
          );
        }
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
