import { type } from "arktype";
import { Platform } from "~/prisma/client/enums";
import prisma from "~/server/internal/db/database";
import { readDropValidatedBody, throwingArktype } from "~/server/arktype";
import aclManager from "~/server/internal/acls";
import { scanInstalledDir } from "~/server/internal/library/pipeline";

const ScanInstallBody = type({
  gameId: "string",
  versionId: "string",
  files: type.string.array().moreThanLength(0).atMostLength(200),
}).configure(throwingArktype);

const AdoptLaunch = type({
  name: "string = 'Play'",
  command: "string",
  platform: type.valueOf(Platform),
}).configure(throwingArktype);

const ScanInstallAdoptBody = ScanInstallBody.and({
  adopt: AdoptLaunch,
});

export default defineEventHandler<{
  body: typeof ScanInstallBody.infer | typeof ScanInstallAdoptBody.infer;
}>(async (h3) => {
  const allowed = await aclManager.allowSystemACL(h3, ["import:version:new"]);
  if (!allowed) throw createError({ statusCode: 403 });

  const raw = await readDropValidatedBody(h3, ScanInstallAdoptBody);
  const { adopt, ...required } = raw as typeof ScanInstallAdoptBody.infer;

  const game = await prisma.game.findUnique({
    where: { id: required.gameId },
    select: {
      id: true,
      mName: true,
      versions: { select: { versionId: true } },
    },
  });
  if (!game)
    throw createError({ statusCode: 400, statusMessage: "Invalid game." });

  const version = game.versions.find((v) => v.versionId === required.versionId);
  if (!version)
    throw createError({ statusCode: 400, statusMessage: "Invalid version." });

  const { candidates } = scanInstalledDir(required.files, game.mName);

  if (adopt) {
    const existing = await prisma.launchConfiguration.findFirst({
      where: { versionId: required.versionId, command: adopt.command },
    });
    if (!existing) {
      await prisma.launchConfiguration.create({
        data: {
          name: adopt.name,
          command: adopt.command,
          platform: adopt.platform as Platform,
          versionId: required.versionId,
        },
      });
    }
  }

  return { candidates };
});
