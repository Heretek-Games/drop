import workshopManager from "~/server/internal/workshop";

export default defineEventHandler(async (h3) => {
  const gameId = getRouterParam(h3, "gameid");
  if (!gameId)
    throw createError({ statusCode: 400, statusMessage: "gameId is required" });

  const mods = await workshopManager.listMods(gameId);
  return { mods, count: mods.length };
});
