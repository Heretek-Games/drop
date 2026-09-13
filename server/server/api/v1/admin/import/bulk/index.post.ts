import { type } from "arktype";
import { GameType } from "~/prisma/client/enums";
import { readDropValidatedBody, throwingArktype } from "~/server/arktype";
import aclManager from "~/server/internal/acls";
import prisma from "~/server/internal/db/database";
import libraryManager from "~/server/internal/library";
import metadataHandler from "~/server/internal/metadata";
import { taskHandler, wrapTaskContext } from "~/server/internal/tasks";

const BulkImport = type({
  ids: "string[]",
}).configure(throwingArktype);

export default defineEventHandler(async (h3) => {
  const allowed = await aclManager.allowSystemACL(h3, [
    "import:game:new",
    "import:version:new",
  ]);
  if (!allowed) throw createError({ statusCode: 403 });

  const body = await readDropValidatedBody(h3, BulkImport);

  const rows = await prisma.discoveredGame.findMany({
    where: {
      id: { in: body.ids },
      decision: "Pending",
    },
  });

  if (rows.length === 0)
    throw createError({
      statusCode: 400,
      statusMessage: "No pending discovered games selected.",
    });

  const taskId = await taskHandler.create({
    key: `bulk-import:${Date.now()}`,
    taskGroup: "import:bulk",
    acls: ["system:import:game:read", "system:import:version:read"],
    name: `Bulk importing ${rows.length} games`,
    async run({ progress, logger, addAction }) {
      let succeeded = 0;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;

        const min = (i / rows.length) * 100;
        const max = ((i + 1) / rows.length) * 100;
        const context = wrapTaskContext(
          { progress, logger, addAction },
          { min, max, prefix: row.libraryPath },
        );

        try {
          // createGame awaits when a parent task is supplied, so the game row
          // exists by the time this returns.
          await metadataHandler.createGameWithoutMetadata(
            row.libraryId,
            row.libraryPath,
            GameType.Game,
            context,
          );

          const game = await prisma.game.findUnique({
            where: {
              libraryKey: {
                libraryId: row.libraryId,
                libraryPath: row.libraryPath,
              },
            },
            select: { id: true },
          });

          if (!game) {
            context.logger.warn(
              `Game was not persisted for ${row.libraryPath}; skipping`,
            );
            continue;
          }

          await libraryManager.importUnimportedVersionsForGame(
            game.id,
            row.libraryId,
            row.libraryPath,
            context,
          );

          const marked = await prisma.discoveredGame.updateMany({
            where: { id: row.id, decision: "Pending" },
            data: { decision: "Imported", importedGameId: game.id },
          });

          if (marked.count === 0) {
            context.logger.warn(
              `Could not mark ${row.libraryPath} as imported (already processed?)`,
            );
          }

          context.addAction(`View Game:/admin/library/${game.id}`);
          succeeded++;
        } catch (e) {
          context.logger.warn(
            `Failed to import ${row.libraryPath}: ${String(e)}`,
          );
        }

        progress(max);
      }

      logger.info(
        `Bulk import finished: ${succeeded}/${rows.length} games imported`,
      );
    },
  });

  return { taskId };
});
