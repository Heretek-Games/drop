import { type } from "arktype";
import { readDropValidatedBody, throwingArktype } from "~/server/arktype";
import aclManager from "~/server/internal/acls";
import prisma from "~/server/internal/db/database";

const DecisionUpdate = type({
  ids: "string[]",
  "decision?": "'Pending' | 'Ignored'",
}).configure(throwingArktype);

export default defineEventHandler(async (h3) => {
  const allowed = await aclManager.allowSystemACL(h3, [
    "import:game:read",
    "import:game:new",
  ]);
  if (!allowed) throw createError({ statusCode: 403 });

  const body = await readDropValidatedBody(h3, DecisionUpdate);

  await prisma.discoveredGame.updateMany({
    where: {
      id: { in: body.ids },
      decision: { not: "Imported" },
    },
    data: {
      decision: body.decision ?? "Ignored",
    },
  });

  return { updated: body.ids.length };
});
