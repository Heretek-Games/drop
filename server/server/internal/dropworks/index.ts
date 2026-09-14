import prisma from "../db/database";
import { hashToken } from "../auth/tokens";
import achievementManager from "../achievements";
import presenceManager from "../presence";
import { APITokenMode } from "~/prisma/client/enums";
import { DropworksManager, type DropworksDeps } from "./manager";

const deps: DropworksDeps = {
  resolveUserByToken: async (token) => {
    const record = await prisma.aPIToken.findUnique({
      where: {
        token: hashToken(token),
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
  submitScore: async (userId, gameId, key, score) => {
    const { improved } = await achievementManager.submitScore(userId, {
      gameId,
      key,
      name: key,
      score,
    });
    return { improved };
  },
  setPresence: (userId, status, gameId) =>
    presenceManager.setStatus(userId, status, gameId),
};

export const dropworksManager = new DropworksManager(deps);
export { DropworksManager };
export * from "./manager";
export default dropworksManager;
