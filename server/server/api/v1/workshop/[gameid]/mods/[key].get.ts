import workshopManager from "~/server/internal/workshop";

export default defineEventHandler(async (h3) => {
  const gameId = getRouterParam(h3, "gameid");
  const key = getRouterParam(h3, "key");
  if (!gameId || !key)
    throw createError({
      statusCode: 400,
      statusMessage: "gameId and key are required",
    });

  return await workshopManager.getMod(gameId, key);
});
