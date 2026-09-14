import { createError } from "h3";

export interface AchievementRecord {
  id: string;
  gameId: string;
  key: string;
  name: string;
  description: string;
  hidden: boolean;
  points: number;
  iconObjectId?: string | null;
}

export interface UserAchievementRecord {
  achievementId: string;
  unlockedAt: Date;
}

export interface AchievementDefinitionInput {
  gameId: string;
  key: string;
  name: string;
  description: string;
  hidden?: boolean;
  points?: number;
  iconObjectId?: string | null;
}

export interface AchievementProgress {
  total: number;
  unlocked: number;
  totalPoints: number;
  unlockedPoints: number;
}

/** Dependency surface kept structural so the manager is unit-testable. */
export interface AchievementsDeps {
  prisma: {
    achievementDefinition: {
      findUnique(args: {
        where: { gameId_key: { gameId: string; key: string } };
      }): Promise<AchievementRecord | null>;
      findMany(args: {
        where: { gameId: string };
      }): Promise<AchievementRecord[]>;
      create(args: {
        data: AchievementDefinitionInput;
      }): Promise<AchievementRecord>;
    };
    userAchievement: {
      findMany(args: {
        where: { userId: string; achievementId: { in: string[] } };
      }): Promise<UserAchievementRecord[]>;
      create(args: {
        data: { userId: string; achievementId: string };
      }): Promise<UserAchievementRecord>;
    };
  };
  emit: (channel: string, event: unknown) => void;
}

/** Pure progress roll-up used by both the API and the desktop UI. */
export function summarizeProgress(
  definitions: AchievementRecord[],
  unlockedIds: Set<string>,
): AchievementProgress {
  let totalPoints = 0;
  let unlockedPoints = 0;
  let unlocked = 0;
  for (const definition of definitions) {
    totalPoints += definition.points;
    if (unlockedIds.has(definition.id)) {
      unlocked += 1;
      unlockedPoints += definition.points;
    }
  }
  return {
    total: definitions.length,
    unlocked,
    totalPoints,
    unlockedPoints,
  };
}

export const ACHIEVEMENT_UNLOCK_CHANNEL = "drop:achievement:unlock";

export class AchievementManager {
  constructor(private readonly deps: AchievementsDeps) {}

  /** Idempotently registers a game's achievement metadata. */
  async registerDefinition(
    input: AchievementDefinitionInput,
  ): Promise<AchievementRecord> {
    const existing = await this.deps.prisma.achievementDefinition.findUnique({
      where: { gameId_key: { gameId: input.gameId, key: input.key } },
    });
    if (existing) return existing;
    return this.deps.prisma.achievementDefinition.create({ data: input });
  }

  /**
   * Unlocks an achievement for a user. Emits `drop:achievement:unlock` exactly
   * once per (user, achievement) so plugin bridges can mirror the unlock.
   */
  async unlock(
    userId: string,
    gameId: string,
    key: string,
  ): Promise<{
    definition: AchievementRecord;
    alreadyUnlocked: boolean;
  }> {
    const definition = await this.deps.prisma.achievementDefinition.findUnique({
      where: { gameId_key: { gameId, key } },
    });
    if (!definition) {
      throw createError({
        statusCode: 404,
        statusMessage: "Unknown achievement",
      });
    }

    const existing = await this.deps.prisma.userAchievement.findMany({
      where: { userId, achievementId: { in: [definition.id] } },
    });
    const alreadyUnlocked = existing.length > 0;
    if (!alreadyUnlocked) {
      await this.deps.prisma.userAchievement.create({
        data: { userId, achievementId: definition.id },
      });
      this.deps.emit(ACHIEVEMENT_UNLOCK_CHANNEL, {
        userId,
        gameId,
        achievementId: definition.id,
        key: definition.key,
        points: definition.points,
      });
    }

    return { definition, alreadyUnlocked };
  }

  async listForUser(
    userId: string,
    gameId: string,
  ): Promise<{
    definitions: AchievementRecord[];
    unlockedIds: string[];
    progress: AchievementProgress;
  }> {
    const definitions = await this.deps.prisma.achievementDefinition.findMany({
      where: { gameId },
    });
    const unlocked = await this.deps.prisma.userAchievement.findMany({
      where: {
        userId,
        achievementId: { in: definitions.map((d) => d.id) },
      },
    });
    const unlockedIds = unlocked.map((entry) => entry.achievementId);
    return {
      definitions,
      unlockedIds,
      progress: summarizeProgress(definitions, new Set(unlockedIds)),
    };
  }
}
