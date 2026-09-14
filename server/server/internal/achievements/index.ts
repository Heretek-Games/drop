import prisma from "../db/database";
import pluginManager from "../plugins";
import { AchievementManager, type AchievementsDeps } from "./manager";

const deps: AchievementsDeps = {
  prisma: prisma as unknown as AchievementsDeps["prisma"],
  emit: (channel, event) => pluginManager.broadcast(channel, event),
};

export const achievementManager = new AchievementManager(deps);
export { AchievementManager };
export {
  ACHIEVEMENT_UNLOCK_CHANNEL,
  summarizeProgress,
  type AchievementDefinitionInput,
  type AchievementProgress,
  type AchievementRecord,
  type AchievementsDeps,
  type UserAchievementRecord,
} from "./manager";
export default achievementManager;
