import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import reviewManager from "~/server/internal/community";

interface ReviewBody {
  rating?: number;
  body?: string;
}

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  const gameId = getRouterParam(h3, "gameid");
  if (!gameId)
    throw createError({ statusCode: 400, statusMessage: "No gameID in route" });

  const payload = ((await readBody<ReviewBody>(h3)) ?? {}) as ReviewBody;
  if (typeof payload.rating !== "number" || typeof payload.body !== "string") {
    throw createError({
      statusCode: 400,
      statusMessage: "rating and body are required",
    });
  }

  return await reviewManager.create(
    user.id,
    gameId,
    payload.rating,
    payload.body,
  );
});
