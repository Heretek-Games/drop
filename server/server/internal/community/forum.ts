import { createError } from "h3";

/**
 * Per-game discussion forums (#20 community hubs).
 *
 * Threads and replies are plain text with hard length caps so a single post
 * cannot bloat the database or the rendered page. Locked threads reject new
 * replies; deletion authorization (author/admin) is enforced at the route.
 */

export interface ForumThreadRecord {
  id: string;
  gameId: string;
  userId: string;
  title: string;
  body: string;
  locked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ForumPostRecord {
  id: string;
  threadId: string;
  userId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_THREAD_TITLE_LENGTH = 200;
export const MAX_POST_LENGTH = 20_000;

/** Dependency surface kept structural so the manager is unit-testable. */
export interface ForumDeps {
  prisma: {
    forumThread: {
      create(args: {
        data: {
          gameId: string;
          userId: string;
          title: string;
          body: string;
        };
      }): Promise<ForumThreadRecord>;
      findUnique(args: {
        where: { id: string };
      }): Promise<ForumThreadRecord | null>;
      findMany(args: {
        where: { gameId: string };
        orderBy: { updatedAt: "asc" | "desc" };
      }): Promise<ForumThreadRecord[]>;
      update(args: {
        where: { id: string };
        data: { locked: boolean };
      }): Promise<ForumThreadRecord>;
      delete(args: { where: { id: string } }): Promise<ForumThreadRecord>;
    };
    forumPost: {
      create(args: {
        data: { threadId: string; userId: string; body: string };
      }): Promise<ForumPostRecord>;
      findMany(args: {
        where: { threadId: string };
        orderBy: { createdAt: "asc" | "desc" };
      }): Promise<ForumPostRecord[]>;
    };
  };
}

function requireText(
  value: string | undefined,
  field: string,
  maxLength: number,
): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `${field} is required`,
    });
  }
  if (trimmed.length > maxLength) {
    throw createError({
      statusCode: 400,
      statusMessage: `${field} must be at most ${maxLength} characters`,
    });
  }
  return trimmed;
}

export class ForumManager {
  constructor(private readonly deps: ForumDeps) {}

  async createThread(
    userId: string,
    gameId: string,
    title: string,
    body: string,
  ): Promise<ForumThreadRecord> {
    return this.deps.prisma.forumThread.create({
      data: {
        gameId,
        userId,
        title: requireText(title, "title", MAX_THREAD_TITLE_LENGTH),
        body: requireText(body, "body", MAX_POST_LENGTH),
      },
    });
  }

  /** Threads newest-updated first, matching a typical forum landing page. */
  async listThreads(gameId: string): Promise<ForumThreadRecord[]> {
    return this.deps.prisma.forumThread.findMany({
      where: { gameId },
      orderBy: { updatedAt: "desc" },
    });
  }

  async getThread(
    threadId: string,
  ): Promise<{ thread: ForumThreadRecord; posts: ForumPostRecord[] } | null> {
    const thread = await this.deps.prisma.forumThread.findUnique({
      where: { id: threadId },
    });
    if (!thread) return null;
    const posts = await this.deps.prisma.forumPost.findMany({
      where: { threadId },
      orderBy: { createdAt: "asc" },
    });
    return { thread, posts };
  }

  async reply(
    userId: string,
    threadId: string,
    body: string,
  ): Promise<ForumPostRecord> {
    const thread = await this.deps.prisma.forumThread.findUnique({
      where: { id: threadId },
    });
    if (!thread) {
      throw createError({ statusCode: 404, statusMessage: "Unknown thread" });
    }
    if (thread.locked) {
      throw createError({ statusCode: 409, statusMessage: "Thread is locked" });
    }
    return this.deps.prisma.forumPost.create({
      data: {
        threadId,
        userId,
        body: requireText(body, "body", MAX_POST_LENGTH),
      },
    });
  }

  async setLocked(
    threadId: string,
    locked: boolean,
  ): Promise<ForumThreadRecord> {
    const thread = await this.deps.prisma.forumThread.findUnique({
      where: { id: threadId },
    });
    if (!thread) {
      throw createError({ statusCode: 404, statusMessage: "Unknown thread" });
    }
    return this.deps.prisma.forumThread.update({
      where: { id: threadId },
      data: { locked },
    });
  }

  /** Delete a thread; returns whether it existed. Authorization is the route's. */
  async deleteThread(threadId: string): Promise<boolean> {
    const thread = await this.deps.prisma.forumThread.findUnique({
      where: { id: threadId },
    });
    if (!thread) return false;
    await this.deps.prisma.forumThread.delete({ where: { id: threadId } });
    return true;
  }
}
