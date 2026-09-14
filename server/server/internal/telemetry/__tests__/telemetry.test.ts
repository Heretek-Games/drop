import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CRASH_MESSAGE_LENGTH,
  TelemetryManager,
  type CrashReportRecord,
  type TelemetryDeps,
} from "../manager";

function createHarness() {
  const reports: CrashReportRecord[] = [];
  let next = 1;

  const deps: TelemetryDeps = {
    prisma: {
      crashReport: {
        create: async ({ data }) => {
          const record: CrashReportRecord = {
            id: `crash-${next++}`,
            gameId: data.gameId,
            userId: data.userId ?? null,
            versionName: data.versionName ?? null,
            platform: data.platform ?? null,
            message: data.message,
            stack: data.stack ?? null,
            createdAt: new Date(Date.now() + reports.length),
          };
          reports.push(record);
          return record;
        },
        findMany: async ({ where, take }) =>
          reports
            .filter((report) => report.gameId === where.gameId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, take ?? reports.length),
        count: async ({ where }) =>
          reports.filter((report) => report.gameId === where.gameId).length,
      },
    },
  };

  return { manager: new TelemetryManager(deps), reports };
}

test("report stores a sanitized crash record", async () => {
  const { manager } = createHarness();
  const record = await manager.report({
    gameId: "game-1",
    userId: "user-1",
    message: "  boom\u0000!  ",
    stack: "at main()",
    platform: "linux",
    versionName: "1.2.0",
  });

  assert.equal(record.message, "boom!");
  assert.equal(record.userId, "user-1");
  assert.equal(record.platform, "linux");
  assert.ok(record.id);
});

test("report requires gameId and message and caps length", async () => {
  const { manager } = createHarness();

  await assert.rejects(
    () => manager.report({ gameId: "", message: "x" }),
    /gameId is required/,
  );
  await assert.rejects(
    () => manager.report({ gameId: "game-1", message: "   " }),
    /message is required/,
  );
  await assert.rejects(
    () =>
      manager.report({
        gameId: "game-1",
        message: "x".repeat(MAX_CRASH_MESSAGE_LENGTH + 1),
      }),
    /at most/,
  );
});

test("blank optional fields are omitted and listing is newest-first", async () => {
  const { manager } = createHarness();
  await manager.report({
    gameId: "game-1",
    message: "first",
    platform: "   ",
  });
  await manager.report({ gameId: "game-1", message: "second" });
  await manager.report({ gameId: "game-2", message: "other" });

  const listed = await manager.listForGame("game-1");
  assert.deepEqual(
    listed.map((report) => report.message),
    ["second", "first"],
  );
  assert.equal(listed[0].platform, null);
  assert.equal(await manager.countForGame("game-1"), 2);
  assert.equal(await manager.countForGame("game-2"), 1);

  const limited = await manager.listForGame("game-1", 1);
  assert.equal(limited.length, 1);
});
