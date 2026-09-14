import { forumManager } from "~/server/internal/community";

export default defineEventHandler(async (h3) => {
  const gameId = getRouterParam(h3, "gameid");
  if (!gameId)
    throw createError({ statusCode: 400, statusMessage: "gameId is required" });

  const threads = await forumManager.listThreads(gameId);
  return { threads, count: threads.length };
});
