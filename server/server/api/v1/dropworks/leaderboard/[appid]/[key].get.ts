import achievementManager from "~/server/internal/achievements";

/** Public global leaderboard for a game (by Drop game id). */
export default defineEventHandler(async (h3) => {
  const gameId = getRouterParam(h3, "appid");
  const key = getRouterParam(h3, "key");
  if (!gameId || !key)
    throw createError({
      statusCode: 400,
      statusMessage: "appId and key are required",
    });

  const limitParam = getQuery(h3).limit;
  const parsedLimit = Number(limitParam);
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), 500)
      : 50;

  return await achievementManager.listLeaderboard(gameId, key, limit);
});
