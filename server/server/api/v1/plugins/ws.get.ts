import pluginManager from "~/server/internal/plugins";

const clientSubscriptions = new Map<string, Array<() => void>>();

export default defineWebSocketHandler({
  open(peer) {
    clientSubscriptions.set(peer.id, []);
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
            userId: undefined,
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
  },
});
