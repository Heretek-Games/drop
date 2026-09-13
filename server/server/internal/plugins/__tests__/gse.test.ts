import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryMeshBackend,
  ZeroTierBackend,
  roomCidr,
} from "../builtin/gse/mesh";
import {
  HOST_LEASE_MS,
  MAX_ROOMS_PER_HOST,
  ROOM_TTL_MS,
  RoomStore,
} from "../builtin/gse/room-store";
import type { PluginStorage } from "../types";
import type { EmulatorBinding } from "../builtin/gse/types";

class MemoryStorage implements PluginStorage {
  private readonly data = new Map<string, unknown>();
  private schemaVersion = 0;
  async get<T>(key: string): Promise<T | null> {
    return this.data.has(key) ? (this.data.get(key) as T) : null;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async listKeys(): Promise<string[]> {
    return [...this.data.keys()];
  }
  async getSchemaVersion(): Promise<number> {
    return this.schemaVersion;
  }
  async setSchemaVersion(version: number): Promise<void> {
    this.schemaVersion = version;
  }
}

const EMULATOR: EmulatorBinding = {
  flavor: "gbe_fork",
  release: "latest",
  releaseDigest: "sha256-default",
};

interface Harness {
  store: RoomStore;
  backend: InMemoryMeshBackend;
  setNow: (value: number) => void;
}

function harness(): Harness {
  let now = 1_000_000;
  const backend = new InMemoryMeshBackend();
  const store = new RoomStore(new MemoryStorage(), backend, () => now);
  return { store, backend, setNow: (value: number) => (now = value) };
}

function createInput(hostUserId: string) {
  return { gameId: "game-1", versionId: "v1", emulator: EMULATOR, hostUserId };
}

test("RoomStore create/list/join/leave and host close", async () => {
  const { store } = harness();

  const room = await store.create(createInput("host"));
  assert.equal(room.members.length, 1);
  assert.equal(room.mesh.backend, "zerotier");
  assert.equal((await store.list("game-1")).length, 1);

  const joined = await store.join(room.id, "guest");
  assert.equal(joined.members.length, 2);

  const left = await store.leave(room.id, "guest");
  assert.equal(left.closed, false);
  assert.equal((await store.get(room.id))?.members.length, 1);

  const closed = await store.leave(room.id, "host");
  assert.equal(closed.closed, true);
  assert.equal(await store.get(room.id), undefined);
  assert.equal((await store.list()).length, 0);
});

test("RoomStore migrates an expired host lease on join", async () => {
  const h = harness();
  const room = await h.store.create(createInput("host"));

  // Guest joins after the host lease has expired.
  h.setNow(1_000_000 + HOST_LEASE_MS + 1);
  const updated = await h.store.join(room.id, "guest");
  assert.equal(updated.hostUserId, "guest");

  // Original host renewing a heartbeat does not steal it back immediately.
  const beat = await h.store.heartbeat(room.id, "host");
  assert.equal(beat.hostUserId, "guest");
});

test("RoomStore credentials are membership-gated and cached", async () => {
  const { store } = harness();
  const room = await store.create(createInput("host"));

  await assert.rejects(
    () => store.credential(room.id, "stranger"),
    /room member/,
  );

  const first = await store.credential(room.id, "host");
  const second = await store.credential(room.id, "host");
  assert.equal(first.secret, second.secret);
  assert.ok(first.secret.length > 0);
});

test("RoomStore prunes expired rooms and tears down their mesh", async () => {
  const h = harness();
  const room = await h.store.create(createInput("host"));
  assert.equal(h.backend.memberCount(room.id), 0);

  h.setNow(1_000_000 + ROOM_TTL_MS + 1);
  const pruned = await h.store.pruneExpired();
  assert.equal(pruned, 1);
  assert.equal((await h.store.list()).length, 0);
});

test("RoomStore caps rooms per host", async () => {
  const { store } = harness();
  for (let i = 0; i < MAX_ROOMS_PER_HOST; i++) {
    await store.create(createInput("host"));
  }
  await assert.rejects(() => store.create(createInput("host")), /host/);
});

test("roomCidr is stable and within the base /16", () => {
  const cidr = roomCidr("room-abc");
  assert.match(cidr, /^10\.242\.\d{1,3}\.0\/24$/);
  assert.equal(cidr, roomCidr("room-abc"));
});

test("ZeroTierBackend provisions a network via the controller API", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const backend = new ZeroTierBackend({
    baseUrl: "http://localhost:9993",
    authToken: "secret-token",
    controllerNodeId: "node123",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "net-xyz" }),
        text: async () => "",
      };
    },
  });

  const mesh = await backend.provision("room-1", 42);
  assert.equal(mesh.backend, "zerotier");
  if (mesh.backend === "zerotier") {
    assert.equal(mesh.networkId, "net-xyz");
    assert.equal(mesh.cidr, roomCidr("room-1"));
  }
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.match(call.url, /\/controller\/network\/node123______$/);
  assert.equal(
    (call.body as { enableBroadcast: boolean }).enableBroadcast,
    true,
  );
});

test("ZeroTierBackend surfaces controller failures", async () => {
  const backend = new ZeroTierBackend({
    baseUrl: "http://localhost:9993",
    authToken: "t",
    controllerNodeId: "n",
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "boom",
    }),
  });
  await assert.rejects(() => backend.provision("room-1", 1), /500/);
});
