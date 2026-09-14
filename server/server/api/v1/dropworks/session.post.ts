import type { H3Event } from "h3";
import dropworksManager from "~/server/internal/dropworks";

interface SessionBody {
  appId?: string;
  authToken?: string;
}

function bearerToken(h3: H3Event): string | undefined {
  const header = getHeader(h3, "Authorization");
  if (!header) return undefined;
  const [type, token] = header.split(" ");
  return type === "Bearer" && token ? token : undefined;
}

export default defineEventHandler(async (h3) => {
  const body = ((await readBody<SessionBody>(h3)) ?? {}) as SessionBody;
  const token = body.authToken ?? bearerToken(h3);
  if (!body.appId || !token) {
    throw createError({
      statusCode: 400,
      statusMessage: "appId and authToken are required",
    });
  }

  const session = await dropworksManager.openSession(body.appId, token);
  return {
    userId: session.userId,
    gameId: session.gameId,
    appId: session.appId,
  };
});
