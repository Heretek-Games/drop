import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import workshopManager from "~/server/internal/workshop";

interface PublishBody {
  manifest?: unknown;
  summary?: string;
  downloadUrl?: string;
  checksum?: string;
}

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  if (!user.admin) {
    throw createError({
      statusCode: 403,
      statusMessage: "Admin access required to publish mods",
    });
  }
  const gameId = getRouterParam(h3, "gameid");
  if (!gameId)
    throw createError({ statusCode: 400, statusMessage: "gameId is required" });

  const body = ((await readBody<PublishBody>(h3)) ?? {}) as PublishBody;
  if (!body.manifest)
    throw createError({
      statusCode: 400,
      statusMessage: "manifest is required",
    });

  const result = await workshopManager.publish({
    gameId,
    manifest: body.manifest,
    summary: body.summary,
    downloadUrl: body.downloadUrl,
    checksum: body.checksum,
  });
  return { success: true, mod: result.mod, release: result.release };
});
