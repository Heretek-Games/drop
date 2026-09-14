import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import achievementManager from "~/server/internal/achievements";

export default defineClientEventHandler(async (h3) => {
  const gameId = getRouterParam(h3, "gameid");
  const key = getRouterParam(h3, "key");
  if (!gameId || !key)
    throw createError({
      statusCode: 400,
      statusMessage: "gameId and key are required",
    });

  const limitParam = getQuery(h3).limit;
  const parsedLimit = Number(limitParam);
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), 500)
      : 50;

  return await achievementManager.listLeaderboard(gameId, key, limit);
});
