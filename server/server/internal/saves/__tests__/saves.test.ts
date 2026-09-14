import test from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { SaveManager, type SaveManagerDeps } from "../manager";

interface SlotState {
  historyObjectIds: string[];
  historyChecksums: string[];
  lastUsedClientId?: string;
}

const keyOf = (where: {
  userId: string;
  gameId: string;
  index: number;
}): string => `${where.userId}:${where.gameId}:${where.index}`;

const slots = new Map<string, SlotState>();
const objects = new Map<string, Buffer>();
const deleted: string[] = [];
let historyLimit = 3;
let sizeLimitMb = 10;

const prisma: SaveManagerDeps["prisma"] = {
  saveSlot: {
    findUnique: async ({ where }) => {
      const record = slots.get(keyOf(where.id));
      if (!record) return null;
      return {
        historyObjectIds: [...record.historyObjectIds],
        historyChecksums: [...record.historyChecksums],
      };
    },
    updateManyAndReturn: async ({ where, data }) => {
      const record = slots.get(keyOf(where));
      if (!record) return [];
      record.historyObjectIds = [
        ...record.historyObjectIds,
        data.historyObjectIds.push,
      ];
      record.historyChecksums = [
        ...record.historyChecksums,
        data.historyChecksums.push,
      ];
      if (data.lastUsedClientId)
        record.lastUsedClientId = data.lastUsedClientId;
      return [
        {
          historyObjectIds: [...record.historyObjectIds],
          historyChecksums: [...record.historyChecksums],
        },
      ];
    },
    updateMany: async ({ where, data }) => {
      const record = slots.get(keyOf(where));
      if (!record) return { count: 0 };
      record.historyObjectIds = [...data.historyObjectIds];
      record.historyChecksums = [...data.historyChecksums];
      return { count: 1 };
    },
  },
};

const objectHandler: SaveManagerDeps["objectHandler"] = {
  createWithStream: async (id) => {
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    sink.on("finish", () => objects.set(id, Buffer.concat(chunks)));
    return sink;
  },
  deleteWithPermission: async (id) => {
    deleted.push(id);
    objects.delete(id);
    return true;
  },
  deleteAsSystem: async (id) => {
    deleted.push(id);
    objects.delete(id);
    return true;
  },
};

const settings: SaveManagerDeps["settings"] = {
  get: async (key) =>
    key === "saveSlotSizeLimit" ? sizeLimitMb : historyLimit,
};

const saveManager = new SaveManager({ prisma, objectHandler, settings });

test("SaveManager.pushSave computes SHA-256 and records history", async () => {
  slots.clear();
  objects.clear();
  deleted.length = 0;
  historyLimit = 3;

  const userId = "user-1";
  const gameId = "game-celeste";
  const index = 1;
  slots.set(keyOf({ userId, gameId, index }), {
    historyObjectIds: [],
    historyChecksums: [],
  });

  const payload = Buffer.from("CELESTE_SAVE_DATA_LEVEL_9");
  const expectedHash = createHash("sha256").update(payload).digest("hex");

  await saveManager.pushSave(
    gameId,
    userId,
    index,
    Readable.from(payload),
    "deck-client",
  );

  const record = slots.get(keyOf({ userId, gameId, index }));
  assert.ok(record);
  assert.equal(record.historyObjectIds.length, 1);
  assert.equal(record.historyChecksums[0], expectedHash);
  assert.equal(record.lastUsedClientId, "deck-client");
  assert.deepEqual(objects.get(record.historyObjectIds[0]), payload);
  assert.equal(deleted.length, 0);
});

test("SaveManager.pushSave prunes history beyond saveSlotHistoryLimit", async () => {
  slots.clear();
  objects.clear();
  deleted.length = 0;
  historyLimit = 2;

  const userId = "user-1";
  const gameId = "game-hollow-knight";
  const index = 1;
  slots.set(keyOf({ userId, gameId, index }), {
    historyObjectIds: ["obj-old-1", "obj-old-2"],
    historyChecksums: ["hash-old-1", "hash-old-2"],
  });

  await saveManager.pushSave(
    gameId,
    userId,
    index,
    Readable.from(Buffer.from("NEW_SAVE_SNAPSHOT")),
  );

  const record = slots.get(keyOf({ userId, gameId, index }));
  assert.ok(record);
  assert.equal(record.historyObjectIds.length, 2);
  assert.deepEqual(deleted, ["obj-old-1"]);
  assert.equal(record.historyObjectIds.includes("obj-old-1"), false);
  assert.equal(record.historyObjectIds.includes("obj-old-2"), true);
});

test("SaveManager.pushSave rejects an unknown save slot", async () => {
  slots.clear();
  deleted.length = 0;

  await assert.rejects(
    () =>
      saveManager.pushSave(
        "non-existent-game",
        "user-1",
        1,
        Readable.from(Buffer.from("x")),
      ),
    /Save not found/,
  );
});

test("SaveManager.pushSave rejects payloads over saveSlotSizeLimit and cleans up", async () => {
  slots.clear();
  objects.clear();
  deleted.length = 0;
  historyLimit = 3;
  sizeLimitMb = 0.000001;

  const userId = "user-1";
  const gameId = "game-too-big";
  const index = 1;
  slots.set(keyOf({ userId, gameId, index }), {
    historyObjectIds: [],
    historyChecksums: [],
  });

  await assert.rejects(
    () =>
      saveManager.pushSave(
        gameId,
        userId,
        index,
        Readable.from(Buffer.from("too big to fit")),
      ),
    /saveSlotSizeLimit/,
  );

  assert.equal(deleted.length, 1);
  const record = slots.get(keyOf({ userId, gameId, index }));
  assert.equal(record?.historyObjectIds.length, 0);
});
