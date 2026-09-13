import aclManager from "~/server/internal/acls";
import prisma from "~/server/internal/db/database";

export default defineEventHandler(async (h3) => {
  const allowed = await aclManager.allowSystemACL(h3, ["import:game:read"]);
  if (!allowed) throw createError({ statusCode: 403 });

  const games = await prisma.discoveredGame.findMany({
    where: {
      decision: "Pending",
    },
    include: {
      library: {
        select: { name: true },
      },
    },
    orderBy: [{ libraryId: "asc" }, { libraryPath: "asc" }],
  });

  return games.map((game) => ({
    id: game.id,
    libraryId: game.libraryId,
    libraryName: game.library.name,
    libraryPath: game.libraryPath,
    inferredType: game.inferredType,
    suggestedName: game.suggestedName,
  }));
});
