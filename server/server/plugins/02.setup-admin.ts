import { APITokenMode } from "~/prisma/client/enums";
import prisma from "~/server/internal/db/database";
import { systemConfig } from "../internal/config/sys-conf";
import { logger } from "../internal/logging";

export default defineNitroPlugin(async (_nitro) => {
  await prisma.aPIToken.deleteMany({
    where: {
      acls: {
        hasSome: ["setup"],
      },
      mode: APITokenMode.System,
    },
  });

  const userCount = await prisma.user.count({
    where: { id: { not: "system" } },
  });
  if (userCount != 0) return;

  // This setup runs every time the server sets up,
  // but has not been configured
  // so it should be in-place

  const token = await prisma.aPIToken.create({
    data: {
      name: "Setup Wizard",
      mode: APITokenMode.System,
      acls: ["setup"],
    },
  });

  const setupBaseUrl = `${systemConfig.getExternalUrl()}/setup`;
  if (process.env.DROP_SETUP_LOG_TOKEN === "true") {
    // Opt-in only: the setup token is a one-time admin credential and must
    // not be written to logs by default.
    logger.info(
      `Open ${setupBaseUrl}?token=${token.token} in a browser to get started with Drop.`,
    );
  } else {
    logger.info(
      `Setup required. Open ${setupBaseUrl} and retrieve the one-time setup ` +
        `token from the "Setup Wizard" API token; set DROP_SETUP_LOG_TOKEN=true ` +
        `to log the full setup URL instead.`,
    );
  }
});
