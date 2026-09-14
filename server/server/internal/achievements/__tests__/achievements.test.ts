import test from "node:test";
import assert from "node:assert/strict";
import {
  ACHIEVEMENT_UNLOCK_CHANNEL,
  AchievementManager,
  summarizeProgress,
  type AchievementRecord,
  type AchievementsDeps,
  type LeaderboardEntryRecord,
  type LeaderboardRecord,
} from "../manager";

function createHarness() {
  const definitions = new Map<string, AchievementRecord>();
  const unlocks = new Set<string>();
  const events: Array<{ channel: string; event: unknown }> = [];
  const leaderboards = new Map<string, LeaderboardRecord>();
  const leaderboardEntries = new Map<string, LeaderboardEntryRecord>();
  let nextId = 1;

  const keyOf = (gameId: string, key: string) => `${gameId}:${key}`;

  const deps: AchievementsDeps = {
    prisma: {
      achievementDefinition: {
        findUnique: async ({ where }) =>
          definitions.get(
            keyOf(where.gameId_key.gameId, where.gameId_key.key),
          ) ?? null,
        findMany: async ({ where }) =>
          [...definitions.values()].filter((d) => d.gameId === where.gameId),
        create: async ({ data }) => {
          const record: AchievementRecord = {
            id: `ach-${nextId++}`,
            gameId: data.gameId,
            key: data.key,
            name: data.name,
            description: data.description,
            hidden: data.hidden ?? false,
            points: data.points ?? 0,
            iconObjectId: data.iconObjectId ?? null,
          };
          definitions.set(keyOf(data.gameId, data.key), record);
          return record;
        },
      },
      userAchievement: {
        findMany: async ({ where }) =>
          where.achievementId.in
            .filter((id) => unlocks.has(`${where.userId}:${id}`))
            .map((achievementId) => ({
              achievementId,
              unlockedAt: new Date(),
            })),
        create: async ({ data }) => {
          unlocks.add(`${data.userId}:${data.achievementId}`);
          return { achievementId: data.achievementId, unlockedAt: new Date() };
        },
      },
      leaderboard: {
        findUnique: async ({ where }) =>
          leaderboards.get(
            keyOf(where.gameId_key.gameId, where.gameId_key.key),
          ) ?? null,
        create: async ({ data }) => {
          const record: LeaderboardRecord = {
            id: `lb-${nextId++}`,
            gameId: data.gameId,
            key: data.key,
            name: data.name,
            sortOrder: data.sortOrder,
          };
          leaderboards.set(keyOf(data.gameId, data.key), record);
          return record;
        },
      },
      leaderboardEntry: {
        findMany: async ({ where, orderBy, take }) => {
          const entries = [...leaderboardEntries.values()].filter(
            (entry) => entry.leaderboardId === where.leaderboardId,
          );
          entries.sort((a, b) =>
            orderBy.score === "asc" ? a.score - b.score : b.score - a.score,
          );
          return take ? entries.slice(0, take) : entries;
        },
        findUnique: async ({ where }) =>
          leaderboardEntries.get(
            `${where.leaderboardId_userId.leaderboardId}:${where.leaderboardId_userId.userId}`,
          ) ?? null,
        create: async ({ data }) => {
          const record: LeaderboardEntryRecord = {
            leaderboardId: data.leaderboardId,
            userId: data.userId,
            score: data.score,
            updatedAt: new Date(),
          };
          leaderboardEntries.set(
            `${data.leaderboardId}:${data.userId}`,
            record,
          );
          return record;
        },
        update: async ({ where, data }) => {
          const key = `${where.leaderboardId_userId.leaderboardId}:${where.leaderboardId_userId.userId}`;
          const existing = leaderboardEntries.get(key);
          if (!existing) throw new Error("missing entry");
          const record: LeaderboardEntryRecord = {
            ...existing,
            score: data.score,
            updatedAt: new Date(),
          };
          leaderboardEntries.set(key, record);
          return record;
        },
      },
    },
    emit: (channel, event) => events.push({ channel, event }),
  };

  return {
    manager: new AchievementManager(deps),
    definitions,
    unlocks,
    events,
  };
}

test("registerDefinition is idempotent by (gameId, key)", async () => {
  const { manager } = createHarness();
  const first = await manager.registerDefinition({
    gameId: "game-1",
    key: "beat-boss",
    name: "Boss Slayer",
    description: "Defeat the first boss",
    points: 10,
  });
  const second = await manager.registerDefinition({
    gameId: "game-1",
    key: "beat-boss",
    name: "Boss Slayer",
    description: "Defeat the first boss",
    points: 10,
  });
  assert.equal(first.id, second.id);
});

test("unlock emits drop:achievement:unlock exactly once", async () => {
  const { manager, events } = createHarness();
  await manager.registerDefinition({
    gameId: "game-1",
    key: "beat-boss",
    name: "Boss Slayer",
    description: "Defeat the first boss",
    points: 10,
  });

  const first = await manager.unlock("user-1", "game-1", "beat-boss");
  const second = await manager.unlock("user-1", "game-1", "beat-boss");

  assert.equal(first.alreadyUnlocked, false);
  assert.equal(second.alreadyUnlocked, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, ACHIEVEMENT_UNLOCK_CHANNEL);
  assert.deepEqual(events[0].event, {
    userId: "user-1",
    gameId: "game-1",
    achievementId: first.definition.id,
    key: "beat-boss",
    points: 10,
  });
});

test("unlock rejects unknown achievements", async () => {
  const { manager } = createHarness();
  await assert.rejects(
    () => manager.unlock("user-1", "game-1", "missing"),
    /Unknown achievement/,
  );
});

test("listForUser rolls up progress", async () => {
  const { manager } = createHarness();
  await manager.registerDefinition({
    gameId: "game-1",
    key: "a",
    name: "A",
    description: "",
    points: 5,
  });
  await manager.registerDefinition({
    gameId: "game-1",
    key: "b",
    name: "B",
    description: "",
    points: 15,
  });
  await manager.unlock("user-1", "game-1", "a");

  const listing = await manager.listForUser("user-1", "game-1");
  assert.equal(listing.progress.total, 2);
  assert.equal(listing.progress.unlocked, 1);
  assert.equal(listing.progress.totalPoints, 20);
  assert.equal(listing.progress.unlockedPoints, 5);
});

test("summarizeProgress ignores unlocks without definitions", () => {
  const definitions: AchievementRecord[] = [
    {
      id: "a",
      gameId: "g",
      key: "a",
      name: "A",
      description: "",
      hidden: false,
      points: 10,
    },
  ];
  const progress = summarizeProgress(definitions, new Set(["a", "ghost"]));
  assert.deepEqual(progress, {
    total: 1,
    unlocked: 1,
    totalPoints: 10,
    unlockedPoints: 10,
  });
});

test("submitScore keeps only the best result per user", async () => {
  const { manager } = createHarness();

  const first = await manager.submitScore("user-1", {
    gameId: "game-1",
    key: "high-score",
    name: "High Score",
    score: 100,
  });
  assert.equal(first.improved, true);

  const worse = await manager.submitScore("user-1", {
    gameId: "game-1",
    key: "high-score",
    name: "High Score",
    score: 50,
  });
  assert.equal(worse.improved, false);
  assert.equal(worse.entry.score, 100);

  const better = await manager.submitScore("user-1", {
    gameId: "game-1",
    key: "high-score",
    name: "High Score",
    score: 150,
  });
  assert.equal(better.improved, true);
  assert.equal(better.entry.score, 150);

  const { entries } = await manager.listLeaderboard("game-1", "high-score");
  assert.deepEqual(
    entries.map((entry) => entry.score),
    [150],
  );
});

test("asc leaderboards keep the lowest score and list ascending", async () => {
  const { manager } = createHarness();

  await manager.submitScore("user-1", {
    gameId: "game-1",
    key: "fastest",
    name: "Fastest Time",
    sortOrder: "asc",
    score: 30,
  });
  await manager.submitScore("user-2", {
    gameId: "game-1",
    key: "fastest",
    name: "Fastest Time",
    sortOrder: "asc",
    score: 10,
  });
  const slower = await manager.submitScore("user-1", {
    gameId: "game-1",
    key: "fastest",
    name: "Fastest Time",
    sortOrder: "asc",
    score: 45,
  });
  assert.equal(slower.improved, false);
  assert.equal(slower.entry.score, 30);

  const { entries } = await manager.listLeaderboard("game-1", "fastest");
  assert.deepEqual(
    entries.map((entry) => entry.score),
    [10, 30],
  );
});

test("listLeaderboard rejects unknown leaderboards", async () => {
  const { manager } = createHarness();
  await assert.rejects(
    () => manager.listLeaderboard("game-1", "missing"),
    /Unknown leaderboard/,
  );
});

test("submitScore rejects non-finite scores", async () => {
  const { manager } = createHarness();
  await assert.rejects(
    () =>
      manager.submitScore("user-1", {
        gameId: "game-1",
        key: "score",
        name: "Score",
        score: Number.NaN,
      }),
    /finite/,
  );
});
