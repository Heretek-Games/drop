import { forumManager } from "~/server/internal/community";

export default defineEventHandler(async (h3) => {
  const threadId = getRouterParam(h3, "threadid");
  if (!threadId)
    throw createError({
      statusCode: 400,
      statusMessage: "threadId is required",
    });

  const result = await forumManager.getThread(threadId);
  if (!result)
    throw createError({ statusCode: 404, statusMessage: "Unknown thread" });
  return result;
});
