import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import telemetryManager from "~/server/internal/telemetry";

/** Admin crash-telemetry view for a game. */
export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  if (!user.admin) {
    throw createError({
      statusCode: 403,
      statusMessage: "Admin access required to view crash reports",
    });
  }
  const gameId = getRouterParam(h3, "gameid");
  if (!gameId)
    throw createError({ statusCode: 400, statusMessage: "gameId is required" });

  const limitParam = getQuery(h3).limit;
  const parsedLimit = Number(
    Array.isArray(limitParam) ? limitParam[0] : limitParam,
  );
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100;

  const [crashes, count] = await Promise.all([
    telemetryManager.listForGame(gameId, limit),
    telemetryManager.countForGame(gameId),
  ]);
  return { crashes, count };
});
