import test from "node:test";
import assert from "node:assert/strict";
import {
  ACHIEVEMENT_UNLOCK_CHANNEL,
  AchievementManager,
  summarizeProgress,
  type AchievementRecord,
  type AchievementsDeps,
} from "../manager";

function createHarness() {
  const definitions = new Map<string, AchievementRecord>();
  const unlocks = new Set<string>();
  const events: Array<{ channel: string; event: unknown }> = [];
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
