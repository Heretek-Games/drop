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

export type LeaderboardSort = "asc" | "desc";

export interface LeaderboardRecord {
  id: string;
  gameId: string;
  key: string;
  name: string;
  sortOrder: string;
}

export interface LeaderboardEntryRecord {
  leaderboardId: string;
  userId: string;
  score: number;
  updatedAt: Date;
}

export interface LeaderboardInput {
  gameId: string;
  key: string;
  name: string;
  sortOrder?: LeaderboardSort;
}

export interface SubmitScoreInput extends LeaderboardInput {
  score: number;
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
    leaderboard: {
      findUnique(args: {
        where: { gameId_key: { gameId: string; key: string } };
      }): Promise<LeaderboardRecord | null>;
      create(args: {
        data: {
          gameId: string;
          key: string;
          name: string;
          sortOrder: string;
        };
      }): Promise<LeaderboardRecord>;
    };
    leaderboardEntry: {
      findMany(args: {
        where: { leaderboardId: string };
        orderBy: { score: LeaderboardSort };
        take?: number;
      }): Promise<LeaderboardEntryRecord[]>;
      findUnique(args: {
        where: {
          leaderboardId_userId: { leaderboardId: string; userId: string };
        };
      }): Promise<LeaderboardEntryRecord | null>;
      create(args: {
        data: { leaderboardId: string; userId: string; score: number };
      }): Promise<LeaderboardEntryRecord>;
      update(args: {
        where: {
          leaderboardId_userId: { leaderboardId: string; userId: string };
        };
        data: { score: number };
      }): Promise<LeaderboardEntryRecord>;
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

  /** Idempotently registers a leaderboard for a game. */
  async upsertLeaderboard(input: LeaderboardInput): Promise<LeaderboardRecord> {
    const existing = await this.deps.prisma.leaderboard.findUnique({
      where: { gameId_key: { gameId: input.gameId, key: input.key } },
    });
    if (existing) return existing;
    return this.deps.prisma.leaderboard.create({
      data: {
        gameId: input.gameId,
        key: input.key,
        name: input.name,
        sortOrder: input.sortOrder ?? "desc",
      },
    });
  }

  /**
   * Records a score, keeping only the user's best result. `asc` leaderboards
   * (e.g. fastest time) keep the lowest score; `desc` keep the highest.
   */
  async submitScore(
    userId: string,
    input: SubmitScoreInput,
  ): Promise<{
    leaderboard: LeaderboardRecord;
    entry: LeaderboardEntryRecord;
    improved: boolean;
  }> {
    if (!Number.isFinite(input.score)) {
      throw createError({
        statusCode: 400,
        statusMessage: "score must be a finite number",
      });
    }
    const leaderboard = await this.upsertLeaderboard(input);
    const existing = await this.deps.prisma.leaderboardEntry.findUnique({
      where: {
        leaderboardId_userId: { leaderboardId: leaderboard.id, userId },
      },
    });
    if (!existing) {
      const entry = await this.deps.prisma.leaderboardEntry.create({
        data: { leaderboardId: leaderboard.id, userId, score: input.score },
      });
      return { leaderboard, entry, improved: true };
    }
    const better =
      leaderboard.sortOrder === "asc"
        ? input.score < existing.score
        : input.score > existing.score;
    if (!better) {
      return { leaderboard, entry: existing, improved: false };
    }
    const entry = await this.deps.prisma.leaderboardEntry.update({
      where: {
        leaderboardId_userId: { leaderboardId: leaderboard.id, userId },
      },
      data: { score: input.score },
    });
    return { leaderboard, entry, improved: true };
  }

  /** Lists a leaderboard's top entries in its configured order. */
  async listLeaderboard(
    gameId: string,
    key: string,
    limit = 50,
  ): Promise<{
    leaderboard: LeaderboardRecord;
    entries: LeaderboardEntryRecord[];
  }> {
    const leaderboard = await this.deps.prisma.leaderboard.findUnique({
      where: { gameId_key: { gameId, key } },
    });
    if (!leaderboard) {
      throw createError({
        statusCode: 404,
        statusMessage: "Unknown leaderboard",
      });
    }
    const sortOrder: LeaderboardSort =
      leaderboard.sortOrder === "asc" ? "asc" : "desc";
    const entries = await this.deps.prisma.leaderboardEntry.findMany({
      where: { leaderboardId: leaderboard.id },
      orderBy: { score: sortOrder },
      take: limit,
    });
    return { leaderboard, entries };
  }
}
