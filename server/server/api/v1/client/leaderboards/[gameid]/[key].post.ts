import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import achievementManager from "~/server/internal/achievements";
import type { LeaderboardSort } from "~/server/internal/achievements";

interface SubmitScoreBody {
  score?: number;
  name?: string;
  sortOrder?: LeaderboardSort;
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

  const body = ((await readBody<SubmitScoreBody>(h3)) ?? {}) as SubmitScoreBody;
  if (typeof body.score !== "number" || !Number.isFinite(body.score)) {
    throw createError({
      statusCode: 400,
      statusMessage: "score must be a finite number",
    });
  }

  const result = await achievementManager.submitScore(user.id, {
    gameId,
    key,
    score: body.score,
    name: body.name ?? key,
    sortOrder: body.sortOrder,
  });

  return {
    improved: result.improved,
    entry: result.entry,
    leaderboard: result.leaderboard,
  };
});
