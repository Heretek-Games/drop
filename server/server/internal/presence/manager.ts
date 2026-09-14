import { createError } from "h3";

/**
 * Local user presence (#20 rich presence).
 *
 * Presence is best-effort, per-user, and refreshed on every report. Entries
 * older than the configured window are considered offline, so a client that
 * stops reporting ages out without an explicit clear.
 */

export const PRESENCE_STATUSES = [
  "online",
  "in-game",
  "away",
  "offline",
] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export const DEFAULT_PRESENCE_STALE_MS = 5 * 60 * 1000;

export interface PresenceRecord {
  userId: string;
  status: string;
  gameId?: string | null;
  updatedAt: Date;
}

export interface OnlineUser {
  userId: string;
  status: string;
  gameId?: string | null;
  updatedAt: Date;
  username?: string;
  displayName?: string;
}

export interface PresenceDeps {
  prisma: {
    userPresence: {
      upsert(args: {
        where: { userId: string };
        create: { userId: string; status: string; gameId: string | null };
        update: { status: string; gameId: string | null };
      }): Promise<PresenceRecord>;
      findUnique(args: {
        where: { userId: string };
      }): Promise<PresenceRecord | null>;
      deleteMany(args: {
        where: { userId: string };
      }): Promise<{ count: number }>;
      findMany(args: {
        where: { updatedAt: { gte: Date } };
        orderBy: { updatedAt: "desc" };
        take?: number;
      }): Promise<PresenceRecord[]>;
    };
    user: {
      findMany(args: {
        where: { id: { in: string[] } };
        select: { id: true; username: true; displayName: true };
      }): Promise<Array<{ id: string; username: string; displayName: string }>>;
    };
  };
}

function isStatus(value: unknown): value is PresenceStatus {
  return (
    typeof value === "string" &&
    (PRESENCE_STATUSES as readonly string[]).includes(value)
  );
}

export class PresenceManager {
  constructor(private readonly deps: PresenceDeps) {}

  /** Refresh a user's presence. */
  async setStatus(
    userId: string,
    status: unknown,
    gameId?: string | null,
  ): Promise<PresenceRecord> {
    if (!isStatus(status)) {
      throw createError({
        statusCode: 400,
        statusMessage: `status must be one of: ${PRESENCE_STATUSES.join(", ")}`,
      });
    }
    if (gameId !== undefined && gameId !== null && typeof gameId !== "string") {
      throw createError({
        statusCode: 400,
        statusMessage: "gameId must be a string",
      });
    }
    const normalizedGameId =
      status === "in-game" && typeof gameId === "string" && gameId.length > 0
        ? gameId
        : null;

    return this.deps.prisma.userPresence.upsert({
      where: { userId },
      create: { userId, status, gameId: normalizedGameId },
      update: { status, gameId: normalizedGameId },
    });
  }

  /** Remove a user's presence (e.g. clean sign-out). */
  async clear(userId: string): Promise<boolean> {
    const { count } = await this.deps.prisma.userPresence.deleteMany({
      where: { userId },
    });
    return count > 0;
  }

  async get(userId: string): Promise<PresenceRecord | null> {
    return this.deps.prisma.userPresence.findUnique({ where: { userId } });
  }

  /** Users seen within the freshness window, newest first, excluding offline. */
  async listOnline(
    staleMs: number = DEFAULT_PRESENCE_STALE_MS,
    limit = 100,
  ): Promise<OnlineUser[]> {
    const since = new Date(Date.now() - Math.max(0, staleMs));
    const records = await this.deps.prisma.userPresence.findMany({
      where: { updatedAt: { gte: since } },
      orderBy: { updatedAt: "desc" },
      take: Math.min(Math.max(1, limit), 500),
    });
    const visible = records.filter((record) => record.status !== "offline");
    if (visible.length === 0) return [];

    const users = await this.deps.prisma.user.findMany({
      where: { id: { in: visible.map((record) => record.userId) } },
      select: { id: true, username: true, displayName: true },
    });
    const byId = new Map(users.map((user) => [user.id, user]));

    return visible.map((record) => {
      const user = byId.get(record.userId);
      return {
        userId: record.userId,
        status: record.status,
        gameId: record.gameId,
        updatedAt: record.updatedAt,
        ...(user
          ? { username: user.username, displayName: user.displayName }
          : {}),
      };
    });
  }
}
