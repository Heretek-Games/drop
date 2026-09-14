import screenshotManager from "~/server/internal/screenshots";

/** Public screenshot gallery for a game (non-private screenshots only). */
export default defineEventHandler(async (h3) => {
  const gameId = getRouterParam(h3, "gameid");
  if (!gameId)
    throw createError({ statusCode: 400, statusMessage: "gameId is required" });

  const screenshots = await screenshotManager.getPublicAllByGame(gameId);
  return { screenshots, count: screenshots.length };
});
