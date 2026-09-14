import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import { forumManager } from "~/server/internal/community";

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  const threadId = getRouterParam(h3, "threadid");
  if (!threadId)
    throw createError({
      statusCode: 400,
      statusMessage: "threadId is required",
    });

  const result = await forumManager.getThread(threadId);
  if (!result)
    throw createError({ statusCode: 404, statusMessage: "Unknown thread" });
  if (result.thread.userId !== user.id && !user.admin) {
    throw createError({
      statusCode: 403,
      statusMessage: "Only the author or an admin may delete a thread",
    });
  }

  const removed = await forumManager.deleteThread(threadId);
  return { success: true, removed };
});
