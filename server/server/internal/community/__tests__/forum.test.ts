import test from "node:test";
import assert from "node:assert/strict";
import {
  ForumManager,
  MAX_POST_LENGTH,
  MAX_THREAD_TITLE_LENGTH,
  type ForumDeps,
  type ForumPostRecord,
  type ForumThreadRecord,
} from "../forum";

function createHarness() {
  const threads = new Map<string, ForumThreadRecord>();
  const posts: ForumPostRecord[] = [];
  let next = 1;

  const deps: ForumDeps = {
    prisma: {
      forumThread: {
        create: async ({ data }) => {
          const record: ForumThreadRecord = {
            id: `thread-${next++}`,
            gameId: data.gameId,
            userId: data.userId,
            title: data.title,
            body: data.body,
            locked: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          threads.set(record.id, record);
          return record;
        },
        findUnique: async ({ where }) => threads.get(where.id) ?? null,
        findMany: async ({ where }) =>
          [...threads.values()].filter((t) => t.gameId === where.gameId),
        update: async ({ where, data }) => {
          const thread = threads.get(where.id);
          if (!thread) throw new Error("missing thread");
          const updated: ForumThreadRecord = { ...thread, locked: data.locked };
          threads.set(updated.id, updated);
          return updated;
        },
        delete: async ({ where }) => {
          const thread = threads.get(where.id);
          if (!thread) throw new Error("missing thread");
          threads.delete(where.id);
          return thread;
        },
      },
      forumPost: {
        create: async ({ data }) => {
          const record: ForumPostRecord = {
            id: `post-${next++}`,
            threadId: data.threadId,
            userId: data.userId,
            body: data.body,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          posts.push(record);
          return record;
        },
        findMany: async ({ where }) =>
          posts.filter((post) => post.threadId === where.threadId),
      },
    },
  };

  return { manager: new ForumManager(deps), threads, posts };
}

test("createThread trims input and lists newest first", async () => {
  const { manager } = createHarness();
  const thread = await manager.createThread(
    "user-1",
    "game-1",
    "  Stuck on boss ",
    "  Any tips?  ",
  );
  assert.equal(thread.title, "Stuck on boss");
  assert.equal(thread.body, "Any tips?");
  assert.equal(thread.locked, false);

  const threads = await manager.listThreads("game-1");
  assert.equal(threads.length, 1);

  await assert.rejects(
    () => manager.createThread("user-1", "game-1", "   ", "body"),
    /title is required/,
  );
});

test("createThread and reply enforce length caps", async () => {
  const { manager } = createHarness();
  await assert.rejects(
    () =>
      manager.createThread(
        "user-1",
        "game-1",
        "x".repeat(MAX_THREAD_TITLE_LENGTH + 1),
        "body",
      ),
    /at most/,
  );

  const thread = await manager.createThread("user-1", "game-1", "T", "B");
  await assert.rejects(
    () => manager.reply("user-2", thread.id, "y".repeat(MAX_POST_LENGTH + 1)),
    /at most/,
  );
});

test("reply appends to a thread and is rejected when locked", async () => {
  const { manager } = createHarness();
  const thread = await manager.createThread("user-1", "game-1", "T", "B");

  const post = await manager.reply("user-2", thread.id, "first reply");
  assert.equal(post.threadId, thread.id);

  const view = await manager.getThread(thread.id);
  assert.equal(view?.thread.id, thread.id);
  assert.deepEqual(
    view?.posts.map((p) => p.body),
    ["first reply"],
  );

  await manager.setLocked(thread.id, true);
  await assert.rejects(
    () => manager.reply("user-2", thread.id, "late reply"),
    /locked/,
  );

  await assert.rejects(
    () => manager.reply("user-2", "missing", "hi"),
    /Unknown thread/,
  );
});

test("deleteThread reports existence and removes the thread", async () => {
  const { manager } = createHarness();
  const thread = await manager.createThread("user-1", "game-1", "T", "B");

  assert.equal(await manager.deleteThread(thread.id), true);
  assert.equal(await manager.deleteThread(thread.id), false);
  assert.equal(await manager.getThread(thread.id), null);
});
