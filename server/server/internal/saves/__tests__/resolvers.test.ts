import test from "node:test";
import assert from "node:assert/strict";
import type { CloudSavePathResolver } from "../../plugins/types";
import { resolveCloudSavePatterns } from "../resolvers";

const context = { gameId: "game-1", gameTitle: "Hollow Knight" };

test("aggregates patterns from every resolver with its id", async () => {
  const resolvers: CloudSavePathResolver[] = [
    {
      id: "ludusavi",
      name: "Ludusavi",
      resolveSavePaths: async () => [
        { pattern: "%APPDATA%/Hollow Knight", winePrefix: true },
      ],
    },
    {
      id: "gamebox",
      name: "GameBox",
      resolveSavePaths: async () => [{ pattern: "~/.config/hollow" }],
    },
  ];

  const patterns = await resolveCloudSavePatterns(resolvers, context);
  assert.equal(patterns.length, 2);
  assert.deepEqual(
    patterns.map((p) => p.resolverId),
    ["ludusavi", "gamebox"],
  );
  assert.equal(patterns[0].winePrefix, true);
});

test("a failing resolver does not break the others", async () => {
  const resolvers: CloudSavePathResolver[] = [
    {
      id: "broken",
      name: "Broken",
      resolveSavePaths: async () => {
        throw new Error("boom");
      },
    },
    {
      id: "ok",
      name: "Ok",
      resolveSavePaths: async () => [{ pattern: "~/.local/share/x" }],
    },
  ];

  const patterns = await resolveCloudSavePatterns(resolvers, context);
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].resolverId, "ok");
});

test("no resolvers yields no patterns", async () => {
  assert.deepEqual(await resolveCloudSavePatterns([], context), []);
});
