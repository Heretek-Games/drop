import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import achievementManager from "~/server/internal/achievements";

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  const gameId = getRouterParam(h3, "gameid");
  if (!gameId)
    throw createError({ statusCode: 400, statusMessage: "No gameID in route" });

  return await achievementManager.listForUser(user.id, gameId);
});
