import test from "node:test";
import assert from "node:assert/strict";
import { PricingManager, type PriceRecord, type PricingDeps } from "../pricing";

function createHarness() {
  const prices = new Map<string, PriceRecord>();
  let next = 1;
  const key = (gameId: string, currency: string) => `${gameId}:${currency}`;

  const deps: PricingDeps = {
    prisma: {
      gamePrice: {
        findUnique: async ({ where }) =>
          prices.get(
            key(where.gameId_currency.gameId, where.gameId_currency.currency),
          ) ?? null,
        create: async ({ data }) => {
          const record: PriceRecord = {
            id: `price-${next++}`,
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          prices.set(key(data.gameId, data.currency), record);
          return record;
        },
        update: async ({ where, data }) => {
          const entry = [...prices.values()].find((p) => p.id === where.id);
          if (!entry) throw new Error("missing price");
          const updated: PriceRecord = {
            ...entry,
            ...data,
            updatedAt: new Date(),
          };
          prices.set(key(updated.gameId, updated.currency), updated);
          return updated;
        },
        findMany: async ({ where }) =>
          [...prices.values()]
            .filter((p) => p.gameId === where.gameId)
            .sort((a, b) => a.currency.localeCompare(b.currency)),
      },
    },
  };

  return { manager: new PricingManager(deps), prices };
}

test("setPrice creates then updates the same (game, currency) price", async () => {
  const { manager } = createHarness();

  const created = await manager.setPrice("game-1", "usd", 1999);
  assert.equal(created.currency, "USD");
  assert.equal(created.amount, 1999);
  assert.equal(created.active, true);

  const updated = await manager.setPrice("game-1", "USD", 1499, false);
  assert.equal(updated.id, created.id);
  assert.equal(updated.amount, 1499);
  assert.equal(updated.active, false);
});

test("setPrice validates currency and amount", async () => {
  const { manager } = createHarness();
  await assert.rejects(() => manager.setPrice("game-1", "us", 100), /3-letter/);
  await assert.rejects(
    () => manager.setPrice("game-1", "USD", -1),
    /non-negative integer/,
  );
  await assert.rejects(
    () => manager.setPrice("game-1", "USD", 1.5),
    /non-negative integer/,
  );
});

test("resolvePrice only returns active prices and lists all tiers", async () => {
  const { manager } = createHarness();
  await manager.setPrice("game-1", "USD", 0);
  await manager.setPrice("game-1", "EUR", 999);

  const free = await manager.resolvePrice("game-1", "usd");
  assert.equal(free?.amount, 0);

  await manager.setPrice("game-1", "EUR", 999, false);
  assert.equal(await manager.resolvePrice("game-1", "eur"), null);
  assert.equal(await manager.resolvePrice("game-2", "usd"), null);

  const tiers = await manager.listPrices("game-1");
  assert.deepEqual(
    tiers.map((tier) => tier.currency),
    ["EUR", "USD"],
  );
});
