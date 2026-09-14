import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import workshopManager from "~/server/internal/workshop";

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  const gameId = getRouterParam(h3, "gameid");
  const key = getRouterParam(h3, "key");
  if (!gameId || !key)
    throw createError({
      statusCode: 400,
      statusMessage: "gameId and key are required",
    });

  const removed = await workshopManager.unsubscribe(user.id, gameId, key);
  return { success: true, removed };
});
