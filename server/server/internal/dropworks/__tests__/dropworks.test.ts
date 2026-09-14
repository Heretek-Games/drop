import test from "node:test";
import assert from "node:assert/strict";
import { DropworksManager, type DropworksDeps } from "../manager";

function createHarness(overrides: Partial<DropworksDeps> = {}) {
  const deps: DropworksDeps = {
    resolveUserByToken: async (token) =>
      token === "valid" ? "user-1" : undefined,
    findGameId: async (appId) =>
      appId === "game-1" || appId === "12345" ? "game-id-1" : undefined,
    unlockAchievement: async () => ({ alreadyUnlocked: false }),
    ...overrides,
  };
  return new DropworksManager(deps);
}

test("openSession resolves the token and app id", async () => {
  const manager = createHarness();

  const session = await manager.openSession("game-1", "valid");
  assert.deepEqual(session, {
    userId: "user-1",
    gameId: "game-id-1",
    appId: "game-1",
  });

  // An external metadata app id resolves to the same Drop game.
  const viaMetadata = await manager.openSession("12345", "valid");
  assert.equal(viaMetadata.gameId, "game-id-1");
});

test("openSession rejects missing input, bad token and unknown app", async () => {
  const manager = createHarness();

  await assert.rejects(
    () => manager.openSession("", "valid"),
    /appId and authToken/,
  );
  await assert.rejects(
    () => manager.openSession("game-1", "nope"),
    /Invalid Dropworks auth token/,
  );
  await assert.rejects(
    () => manager.openSession("missing", "valid"),
    /Unknown appId/,
  );
});

test("unlockAchievement authenticates and rejects userId spoofing", async () => {
  let seen: { userId: string; gameId: string; key: string } | null = null;
  const manager = createHarness({
    unlockAchievement: async (userId, gameId, key) => {
      seen = { userId, gameId, key };
      return { alreadyUnlocked: true };
    },
  });

  const result = await manager.unlockAchievement(
    "valid",
    "game-1",
    "beat-boss",
    "user-1",
  );
  assert.deepEqual(result, { unlocked: true, alreadyUnlocked: true });
  assert.deepEqual(seen, {
    userId: "user-1",
    gameId: "game-id-1",
    key: "beat-boss",
  });

  await assert.rejects(
    () => manager.unlockAchievement("valid", "game-1", "beat-boss", "attacker"),
    /does not match/,
  );
  await assert.rejects(
    () => manager.unlockAchievement("nope", "game-1", "beat-boss"),
    /Invalid Dropworks auth token/,
  );
  await assert.rejects(
    () => manager.unlockAchievement("valid", "", ""),
    /appId and achievementId/,
  );
});
