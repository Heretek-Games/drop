import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import { forumManager } from "~/server/internal/community";

interface ReplyBody {
  body?: string;
}

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  const threadId = getRouterParam(h3, "threadid");
  if (!threadId)
    throw createError({
      statusCode: 400,
      statusMessage: "threadId is required",
    });

  const payload = ((await readBody<ReplyBody>(h3)) ?? {}) as ReplyBody;
  if (typeof payload.body !== "string") {
    throw createError({ statusCode: 400, statusMessage: "body is required" });
  }

  const post = await forumManager.reply(user.id, threadId, payload.body);
  return { success: true, post };
});
