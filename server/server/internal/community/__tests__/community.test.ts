import test from "node:test";
import assert from "node:assert/strict";
import {
  ReviewManager,
  isVerifiedReview,
  type ReviewDeps,
  type ReviewRecord,
} from "../manager";

function createHarness(playtimeSeconds: number) {
  const reviews = new Map<string, ReviewRecord>();
  let nextId = 1;

  const deps: ReviewDeps = {
    verifiedPlaytimeSeconds: 3600,
    prisma: {
      playtime: {
        findUnique: async () =>
          playtimeSeconds > 0 ? { seconds: playtimeSeconds } : null,
      },
      gameReview: {
        findUnique: async ({ where }) =>
          reviews.get(
            `${where.gameId_userId.gameId}:${where.gameId_userId.userId}`,
          ) ?? null,
        create: async ({ data }) => {
          const record: ReviewRecord = {
            id: `review-${nextId++}`,
            createdAt: new Date(),
            ...data,
          };
          reviews.set(`${data.gameId}:${data.userId}`, record);
          return record;
        },
        findMany: async ({ where }) =>
          [...reviews.values()].filter((r) => r.gameId === where.gameId),
      },
    },
  };

  return { manager: new ReviewManager(deps), reviews };
}

test("verified reviews require the playtime threshold", () => {
  assert.equal(isVerifiedReview(3599, 3600), false);
  assert.equal(isVerifiedReview(3600, 3600), true);
});

test("a review is marked verified when playtime passes the threshold", async () => {
  const { manager } = createHarness(7200);
  const review = await manager.create("user-1", "game-1", 5, "Masterpiece");
  assert.equal(review.verified, true);
});

test("a review without playtime is unverified", async () => {
  const { manager } = createHarness(0);
  const review = await manager.create("user-1", "game-1", 3, "It was fine");
  assert.equal(review.verified, false);
});

test("duplicate reviews are rejected and ratings validated", async () => {
  const { manager } = createHarness(7200);
  await manager.create("user-1", "game-1", 5, "Great");
  await assert.rejects(
    () => manager.create("user-1", "game-1", 4, "Changed my mind"),
    /already reviewed/,
  );
  await assert.rejects(
    () => manager.create("user-2", "game-1", 9, "Out of range"),
    /rating must be/,
  );
});
