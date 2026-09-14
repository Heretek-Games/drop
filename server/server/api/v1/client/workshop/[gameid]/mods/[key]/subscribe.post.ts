import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import workshopManager from "~/server/internal/workshop";

interface SubscribeBody {
  version?: string;
}

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  const gameId = getRouterParam(h3, "gameid");
  const key = getRouterParam(h3, "key");
  if (!gameId || !key)
    throw createError({
      statusCode: 400,
      statusMessage: "gameId and key are required",
    });

  const body = ((await readBody<SubscribeBody>(h3)) ?? {}) as SubscribeBody;
  const subscription = await workshopManager.subscribe(
    user.id,
    gameId,
    key,
    body.version,
  );
  return { success: true, subscription };
});
