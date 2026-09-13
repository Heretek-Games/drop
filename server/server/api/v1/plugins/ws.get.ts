import pluginManager from "~/server/internal/plugins";
import aclManager from "~/server/internal/acls";

const clientSubscriptions = new Map<string, Array<() => void>>();
const peerUsers = new Map<string, string | undefined>();
const peerAcls = new Map<string, string[] | undefined>();

export default defineWebSocketHandler({
  async open(peer) {
    clientSubscriptions.set(peer.id, []);

    // Authenticate the upgrade request so plugins receive a userId.
    let userId: string | undefined;
    let userAcls: string[] | undefined;
    try {
      userId = (await aclManager.getUserIdACL(peer.request, [])) ?? undefined;
      const all = await aclManager.fetchAllACLs(peer.request);
      userAcls = all ? Array.from(all) : undefined;
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
      const data = JSON.parse(text);

      if (data.type === "subscribe" && typeof data.channel === "string") {
        const unsubscribe = pluginManager.subscribe(data.channel, (event) => {
          peer.send(JSON.stringify({ channel: data.channel, data: event }));
        });
        clientSubscriptions.get(peer.id)?.push(unsubscribe);
        return;
      }

      if (data.type === "message" && typeof data.channel === "string") {
        const handled = await pluginManager.dispatchWebSocket(
          data.channel,
          data.data,
          {
            userId: peerUsers.get(peer.id),
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
    peerUsers.delete(peer.id);
    peerAcls.delete(peer.id);
  },
});
