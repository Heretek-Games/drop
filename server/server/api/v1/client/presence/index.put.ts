import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import presenceManager from "~/server/internal/presence";

interface PresenceBody {
  status?: string;
  gameId?: string;
}

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  const body = ((await readBody<PresenceBody>(h3)) ?? {}) as PresenceBody;
  if (typeof body.status !== "string") {
    throw createError({
      statusCode: 400,
      statusMessage: "status is required",
    });
  }

  const record = await presenceManager.setStatus(
    user.id,
    body.status,
    body.gameId,
  );
  return { success: true, presence: record };
});
