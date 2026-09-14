import test from "node:test";
import assert from "node:assert/strict";
import {
  PresenceManager,
  type OnlineUser,
  type PresenceDeps,
  type PresenceRecord,
} from "../manager";

function createHarness() {
  const presence = new Map<string, PresenceRecord>();
  const users = new Map([
    ["u1", { id: "u1", username: "alice", displayName: "Alice" }],
    ["u2", { id: "u2", username: "bob", displayName: "Bob" }],
  ]);

  const deps: PresenceDeps = {
    prisma: {
      userPresence: {
        upsert: async ({ where, create, update }) => {
          const existing = presence.get(where.userId);
          const record: PresenceRecord = existing
            ? { ...existing, ...update, updatedAt: new Date() }
            : {
                userId: create.userId,
                status: create.status,
                gameId: create.gameId,
                updatedAt: new Date(),
              };
          presence.set(record.userId, record);
          return record;
        },
        findUnique: async ({ where }) => presence.get(where.userId) ?? null,
        deleteMany: async ({ where }) => ({
          count: presence.delete(where.userId) ? 1 : 0,
        }),
        findMany: async ({ where, take }) =>
          [...presence.values()]
            .filter((record) => record.updatedAt >= where.updatedAt.gte)
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            .slice(0, take ?? undefined),
      },
      user: {
        findMany: async ({ where }) =>
          where.id.in
            .map((id) => users.get(id))
            .filter((user): user is NonNullable<typeof user> => Boolean(user)),
      },
    },
  };

  return { manager: new PresenceManager(deps), presence };
}

test("setStatus upserts and validates input", async () => {
  const { manager, presence } = createHarness();

  const first = await manager.setStatus("u1", "online");
  assert.equal(first.status, "online");
  assert.equal(first.gameId, null);

  const playing = await manager.setStatus("u1", "in-game", "game-1");
  assert.equal(playing.status, "in-game");
  assert.equal(playing.gameId, "game-1");

  // Leaving in-game clears the game id.
  const back = await manager.setStatus("u1", "online", "game-1");
  assert.equal(back.gameId, null);

  await assert.rejects(
    () => manager.setStatus("u1", "bogus"),
    /status must be one of/,
  );
  assert.equal(presence.size, 1);
});

test("clear removes presence", async () => {
  const { manager } = createHarness();
  await manager.setStatus("u1", "online");
  assert.equal(await manager.clear("u1"), true);
  assert.equal(await manager.clear("u1"), false);
  assert.equal(await manager.get("u1"), null);
});

test("listOnline filters stale and offline users and joins profiles", async () => {
  const { manager, presence } = createHarness();
  await manager.setStatus("u1", "in-game", "game-1");
  await manager.setStatus("u2", "away");

  // Force u2 stale.
  const stale = presence.get("u2");
  if (stale) {
    presence.set("u2", {
      ...stale,
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
  }

  const online: OnlineUser[] = await manager.listOnline(5 * 60 * 1000);
  assert.equal(online.length, 1);
  assert.equal(online[0].userId, "u1");
  assert.equal(online[0].displayName, "Alice");
  assert.equal(online[0].gameId, "game-1");

  // Offline status is hidden even when fresh.
  await manager.setStatus("u2", "offline");
  const filtered = await manager.listOnline(5 * 60 * 1000);
  assert.deepEqual(
    filtered.map((user) => user.userId),
    ["u1"],
  );
});
