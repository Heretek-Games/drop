import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import { forumManager } from "~/server/internal/community";

interface CreateThreadBody {
  title?: string;
  body?: string;
}

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  const gameId = getRouterParam(h3, "gameid");
  if (!gameId)
    throw createError({ statusCode: 400, statusMessage: "gameId is required" });

  const payload = ((await readBody<CreateThreadBody>(h3)) ??
    {}) as CreateThreadBody;
  if (typeof payload.title !== "string" || typeof payload.body !== "string") {
    throw createError({
      statusCode: 400,
      statusMessage: "title and body are required",
    });
  }

  const thread = await forumManager.createThread(
    user.id,
    gameId,
    payload.title,
    payload.body,
  );
  return { success: true, thread };
});
