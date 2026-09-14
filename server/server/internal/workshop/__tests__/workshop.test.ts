import test from "node:test";
import assert from "node:assert/strict";
import {
  WorkshopManager,
  compareVersions,
  parseModManifest,
  resolveInstallPlan,
  isSafeModPath,
  type ModRecord,
  type ModReleaseRecord,
  type ModSubscriptionRecord,
  type WorkshopDeps,
} from "../index";

function createHarness() {
  const mods = new Map<string, ModRecord>();
  const releases: ModReleaseRecord[] = [];
  const subs = new Map<string, ModSubscriptionRecord>();
  let next = 1;

  const gameKey = (gameId: string, key: string) => `${gameId}:${key}`;
  const subKey = (userId: string, modId: string) => `${userId}:${modId}`;

  const deps: WorkshopDeps = {
    prisma: {
      mod: {
        findUnique: async ({ where }) =>
          mods.get(gameKey(where.gameId_key.gameId, where.gameId_key.key)) ??
          null,
        create: async ({ data }) => {
          const record: ModRecord = {
            id: `mod-${next++}`,
            gameId: data.gameId,
            key: data.key,
            name: data.name,
            summary: data.summary,
            author: data.author ?? null,
            createdAt: new Date(),
          };
          mods.set(gameKey(data.gameId, data.key), record);
          return record;
        },
        update: async ({ where, data }) => {
          const entry = [...mods.values()].find((m) => m.id === where.id);
          if (!entry) throw new Error("missing mod");
          const updated: ModRecord = { ...entry, ...data };
          mods.set(gameKey(updated.gameId, updated.key), updated);
          return updated;
        },
        findMany: async ({ where }) =>
          [...mods.values()].filter((m) => m.gameId === where.gameId),
      },
      modRelease: {
        findUnique: async ({ where }) =>
          releases.find(
            (r) =>
              r.modId === where.modId_version.modId &&
              r.version === where.modId_version.version,
          ) ?? null,
        create: async ({ data }) => {
          const record: ModReleaseRecord = {
            id: `rel-${next++}`,
            modId: data.modId,
            version: data.version,
            manifest: data.manifest,
            downloadUrl: data.downloadUrl ?? null,
            checksum: data.checksum ?? null,
            createdAt: new Date(),
          };
          releases.push(record);
          return record;
        },
        findMany: async ({ where }) =>
          releases.filter((r) => r.modId === where.modId),
      },
      modSubscription: {
        findUnique: async ({ where }) =>
          subs.get(
            subKey(where.userId_modId.userId, where.userId_modId.modId),
          ) ?? null,
        create: async ({ data }) => {
          const record: ModSubscriptionRecord = {
            userId: data.userId,
            modId: data.modId,
            pinnedVersion: data.pinnedVersion ?? null,
            createdAt: new Date(),
          };
          subs.set(subKey(data.userId, data.modId), record);
          return record;
        },
        update: async ({ where, data }) => {
          const key = subKey(
            where.userId_modId.userId,
            where.userId_modId.modId,
          );
          const entry = subs.get(key);
          if (!entry) throw new Error("missing subscription");
          const updated: ModSubscriptionRecord = {
            ...entry,
            pinnedVersion: data.pinnedVersion ?? null,
          };
          subs.set(key, updated);
          return updated;
        },
        delete: async ({ where }) => {
          const key = subKey(
            where.userId_modId.userId,
            where.userId_modId.modId,
          );
          const entry = subs.get(key);
          if (!entry) throw new Error("missing subscription");
          subs.delete(key);
          return entry;
        },
        findMany: async ({ where }) =>
          [...subs.values()].filter((s) => s.userId === where.userId),
      },
    },
  };

  return { manager: new WorkshopManager(deps), mods, releases, subs };
}

const baseManifest = {
  id: "hi-res-textures",
  name: "Hi-Res Textures",
  version: "1.0.0",
  author: "modder",
  description: "4K texture pack",
  files: ["textures/pack.pak"],
};

test("parseModManifest validates required fields and paths", () => {
  const manifest = parseModManifest(baseManifest);
  assert.equal(manifest.id, "hi-res-textures");
  assert.deepEqual(manifest.files, ["textures/pack.pak"]);

  assert.throws(() => parseModManifest({ ...baseManifest, id: "" }), /id is/);
  assert.throws(
    () => parseModManifest({ ...baseManifest, version: "1.0" }),
    /semver/,
  );
  assert.throws(
    () => parseModManifest({ ...baseManifest, files: ["../escape.pak"] }),
    /unsafe file path/,
  );
  assert.throws(
    () => parseModManifest({ ...baseManifest, dependencies: "nope" }),
    /dependencies must be an array/,
  );
});

test("isSafeModPath rejects absolute and traversing paths", () => {
  assert.equal(isSafeModPath("a/b.pak"), true);
  assert.equal(isSafeModPath("/etc/passwd"), false);
  assert.equal(isSafeModPath(String.raw`C:\Windows\x`), false);
  assert.equal(isSafeModPath("a/../b"), false);
});

test("compareVersions orders numeric cores", () => {
  assert.equal(compareVersions("1.2.0", "1.10.0"), -1);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("publish upserts the mod and its release", async () => {
  const { manager } = createHarness();

  const first = await manager.publish({
    gameId: "game-1",
    manifest: baseManifest,
  });
  assert.equal(first.mod.key, "hi-res-textures");
  assert.equal(first.release.version, "1.0.0");

  // Same version is idempotent; same mod with a new name updates in place.
  const second = await manager.publish({
    gameId: "game-1",
    manifest: { ...baseManifest, name: "Hi-Res Textures 2" },
  });
  assert.equal(second.mod.id, first.mod.id);
  assert.equal(second.mod.name, "Hi-Res Textures 2");
  assert.equal(second.release.id, first.release.id);

  const mods = await manager.listMods("game-1");
  assert.equal(mods.length, 1);
});

test("getMod returns releases and the latest semver", async () => {
  const { manager } = createHarness();
  await manager.publish({
    gameId: "game-1",
    manifest: { ...baseManifest, version: "1.0.0" },
  });
  await manager.publish({
    gameId: "game-1",
    manifest: { ...baseManifest, version: "1.10.0" },
  });

  const { latest, releases } = await manager.getMod(
    "game-1",
    "hi-res-textures",
  );
  assert.equal(releases.length, 2);
  assert.equal(latest?.version, "1.10.0");

  await assert.rejects(
    () => manager.getMod("game-1", "missing"),
    /Unknown mod/,
  );
});

test("subscriptions can be added, pinned, listed and removed", async () => {
  const { manager } = createHarness();
  await manager.publish({ gameId: "game-1", manifest: baseManifest });

  const created = await manager.subscribe(
    "user-1",
    "game-1",
    "hi-res-textures",
  );
  assert.equal(created.pinnedVersion, null);

  const pinned = await manager.subscribe(
    "user-1",
    "game-1",
    "hi-res-textures",
    "1.0.0",
  );
  assert.equal(pinned.pinnedVersion, "1.0.0");

  const list = await manager.listSubscriptions("user-1");
  assert.equal(list.length, 1);

  assert.equal(
    await manager.unsubscribe("user-1", "game-1", "hi-res-textures"),
    true,
  );
  assert.equal(
    await manager.unsubscribe("user-1", "game-1", "hi-res-textures"),
    false,
  );
});

test("resolveInstallPlan orders dependencies first and reports gaps", () => {
  const lookup = (id: string) =>
    ({
      lib: {
        id: "lib",
        name: "Lib",
        version: "1.0.0",
        dependencies: [],
        files: [],
      },
      pack: {
        id: "pack",
        name: "Pack",
        version: "1.0.0",
        dependencies: [{ id: "lib" }, { id: "missing" }],
        files: [],
      },
    })[id];

  const plan = resolveInstallPlan(lookup("pack")!, lookup);
  assert.deepEqual(plan.order, ["lib", "pack"]);
  assert.deepEqual(plan.missing, ["missing"]);

  const cyclic = (id: string) =>
    ({
      a: {
        id: "a",
        name: "A",
        version: "1.0.0",
        dependencies: [{ id: "b" }],
        files: [],
      },
      b: {
        id: "b",
        name: "B",
        version: "1.0.0",
        dependencies: [{ id: "a" }],
        files: [],
      },
    })[id];
  assert.throws(() => resolveInstallPlan(cyclic("a")!, cyclic), /cycle/);
});
