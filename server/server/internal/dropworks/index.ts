import prisma from "../db/database";
import achievementManager from "../achievements";
import { APITokenMode } from "~/prisma/client/enums";
import { DropworksManager, type DropworksDeps } from "./manager";

const deps: DropworksDeps = {
  resolveUserByToken: async (token) => {
    const record = await prisma.aPIToken.findUnique({
      where: {
        token,
        mode: { in: [APITokenMode.User, APITokenMode.Client] },
      },
    });
    return record?.userId ?? undefined;
  },
  findGameId: async (appId) => {
    const game = await prisma.game.findFirst({
      where: { OR: [{ id: appId }, { metadataId: appId }] },
      select: { id: true },
    });
    return game?.id;
  },
  unlockAchievement: (userId, gameId, key) =>
    achievementManager.unlock(userId, gameId, key),
};

export const dropworksManager = new DropworksManager(deps);
export { DropworksManager };
export * from "./manager";
export default dropworksManager;
