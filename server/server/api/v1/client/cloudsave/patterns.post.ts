import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import pluginManager from "~/server/internal/plugins";
import { resolveCloudSavePatterns } from "~/server/internal/saves/resolvers";
import type { GameInstallContext } from "~/server/internal/plugins/types";

interface PatternBody {
  gameId?: string;
  gameTitle?: string;
  installDir?: string;
  winePrefix?: string;
  executableName?: string;
}

/**
 * Resolves save-file patterns for a game through every registered
 * `CloudSaveProvider` SPI resolver (e.g. the Ludusavi plugin). The desktop
 * client sends its local install context because prefixes live client-side.
 */
export default defineClientEventHandler(async (h3) => {
  const body = ((await readBody<PatternBody>(h3)) ?? {}) as PatternBody;
  if (!body.gameId || !body.gameTitle) {
    throw createError({
      statusCode: 400,
      statusMessage: "gameId and gameTitle are required",
    });
  }

  const context: GameInstallContext = {
    gameId: body.gameId,
    gameTitle: body.gameTitle,
    installDir: body.installDir,
    winePrefix: body.winePrefix,
    executableName: body.executableName,
  };

  return await resolveCloudSavePatterns(
    pluginManager.getCloudSaveResolvers(),
    context,
  );
});
