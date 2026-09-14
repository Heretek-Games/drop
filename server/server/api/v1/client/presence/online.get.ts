import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import presenceManager from "~/server/internal/presence";

/** Online users within the freshness window (best-effort presence). */
export default defineClientEventHandler(async (h3) => {
  const staleParam = getQuery(h3).staleMs;
  const parsed = Number(Array.isArray(staleParam) ? staleParam[0] : staleParam);
  const staleMs =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, 3_600_000)
      : undefined;

  const users = await presenceManager.listOnline(staleMs);
  return { users, count: users.length };
});
