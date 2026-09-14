import type { H3Event } from "h3";
import dropworksManager from "~/server/internal/dropworks";

interface AchievementBody {
  appId?: string;
  userId?: string;
  achievementId?: string;
  authToken?: string;
}

function bearerToken(h3: H3Event): string | undefined {
  const header = getHeader(h3, "Authorization");
  if (!header) return undefined;
  const [type, token] = header.split(" ");
  return type === "Bearer" && token ? token : undefined;
}

export default defineEventHandler(async (h3) => {
  const body = ((await readBody<AchievementBody>(h3)) ?? {}) as AchievementBody;
  const token = body.authToken ?? bearerToken(h3);
  if (!token) {
    throw createError({
      statusCode: 401,
      statusMessage: "A Dropworks auth token is required",
    });
  }

  return await dropworksManager.unlockAchievement(
    token,
    body.appId ?? "",
    body.achievementId ?? "",
    body.userId,
  );
});
