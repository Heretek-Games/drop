import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import telemetryManager from "~/server/internal/telemetry";

interface CrashBody {
  gameId?: string;
  message?: string;
  stack?: string;
  versionName?: string;
  platform?: string;
}

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  const body = ((await readBody<CrashBody>(h3)) ?? {}) as CrashBody;
  if (typeof body.gameId !== "string" || typeof body.message !== "string") {
    throw createError({
      statusCode: 400,
      statusMessage: "gameId and message are required",
    });
  }

  const report = await telemetryManager.report({
    gameId: body.gameId,
    message: body.message,
    stack: body.stack,
    versionName: body.versionName,
    platform: body.platform,
    userId: user.id,
  });
  return { success: true, id: report.id };
});
