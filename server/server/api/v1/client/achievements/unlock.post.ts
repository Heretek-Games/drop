import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import achievementManager from "~/server/internal/achievements";

interface UnlockBody {
  gameId?: string;
  key?: string;
}

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  const body = ((await readBody<UnlockBody>(h3)) ?? {}) as UnlockBody;
  if (!body.gameId || !body.key)
    throw createError({
      statusCode: 400,
      statusMessage: "gameId and key are required",
    });

  const result = await achievementManager.unlock(
    user.id,
    body.gameId,
    body.key,
  );
  return { unlocked: true, alreadyUnlocked: result.alreadyUnlocked };
});
