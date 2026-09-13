import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryMeshBackend,
  TailscaleApiProvisioner,
  TailscaleBackend,
  ZeroTierBackend,
  roomCidr,
} from "../builtin/gse/mesh";
import { CompatRegistry, compatFromEnv } from "../builtin/gse/compat";
import {
  CREDENTIAL_ROTATION_WINDOW_MS,
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
  assert.ok(first.address);

  // The assigned address is reflected in the room member view.
  const refreshed = await store.get(room.id);
  assert.equal(
    refreshed?.members.find((member) => member.userId === "host")?.meshAddress,
    first.address,
  );
});

test("TailscaleBackend provisions a tag and issues one-off keys", async () => {
  const events: string[] = [];
  const backend = new TailscaleBackend({
    provisionRoom: async (roomId) => {
      events.push(`provision:${roomId}`);
      return `tag:dropgse-room-${roomId}`;
    },
    issueAuthKey: async (tag, userId) => {
      events.push(`key:${tag}:${userId}`);
      return `tskey-${userId}`;
    },
    teardownRoom: async (roomId) => {
      events.push(`teardown:${roomId}`);
    },
  });

  const mesh = await backend.provision("r1", 10);
  assert.equal(mesh.backend, "tailscale");
  const issued = await backend.issueCredential("r1", "u1", mesh);
  assert.equal(issued.secret, "tskey-u1");
  await backend.teardown("r1");
  assert.deepEqual(events, [
    "provision:r1",
    "key:tag:dropgse-room-r1:u1",
    "teardown:r1",
  ]);
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

test("ZeroTierBackend authorizes members and deletes networks", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const backend = new ZeroTierBackend({
    baseUrl: "http://localhost:9993",
    authToken: "t",
    controllerNodeId: "n",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method });
      if (url.includes("/controller/network/") && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "net-1" }),
          text: async () => "",
        };
      }
      if (url.includes("/network/net-1/member/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ assignedAddresses: ["10.242.5.20/24"] }),
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
      };
    },
  });

  await backend.provision("room-9", 1);
  const address = await backend.authorizeMember("room-9", "member-abc");
  assert.equal(address, "10.242.5.20");

  await backend.teardown("room-9");
  const teardownCall = calls.find((call) => call.method === "DELETE");
  assert.ok(teardownCall);
  assert.match(teardownCall.url, /\/controller\/network\/net-1$/);
});

test("TailscaleApiProvisioner issues one-off keys and revokes them", async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const provisioner = new TailscaleApiProvisioner({
    apiKey: "ts-key",
    tailnet: "example.com",
    tag: "tag:dropgse",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body });
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "key-1", key: "tskey-ephemeral" }),
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
      };
    },
  });

  const backend = new TailscaleBackend(provisioner);
  const mesh = await backend.provision("room-1", 1);
  const issued = await backend.issueCredential("room-1", "user-1", mesh);
  assert.equal(issued.secret, "tskey-ephemeral");

  await backend.teardown("room-1");
  const post = calls.find((call) => call.method === "POST");
  assert.ok(post);
  assert.equal(
    (
      JSON.parse(post.body ?? "{}") as {
        capabilities: { devices: { create: { tags: string[] } } };
      }
    ).capabilities.devices.create.tags[0],
    "tag:dropgse",
  );
  assert.ok(
    calls.some(
      (call) => call.method === "DELETE" && call.url.endsWith("/keys/key-1"),
    ),
  );
});

test("RoomStore records the address authorized for a member node", async () => {
  const { store } = harness();
  const room = await store.create(createInput("host"));
  const updated = await store.registerMember(room.id, "host", "node-1");
  assert.ok(updated.members.find((m) => m.userId === "host")?.meshAddress);
});

test("RoomStore rejects known-incompatible games and pins AppID", async () => {
  const store = new RoomStore(
    new MemoryStorage(),
    new InMemoryMeshBackend(),
    () => 1_000_000,
    new CompatRegistry({ blockedAppIds: [1234], blockedGameIds: ["bad-game"] }),
  );

  await assert.rejects(
    () =>
      store.create({
        gameId: "game-1",
        versionId: "v1",
        appId: 1234,
        emulator: EMULATOR,
        hostUserId: "host",
      }),
    /incompatible/,
  );
  await assert.rejects(
    () =>
      store.create({
        gameId: "bad-game",
        versionId: "v1",
        emulator: EMULATOR,
        hostUserId: "host",
      }),
    /incompatible/,
  );

  const room = await store.create({
    gameId: "good-game",
    versionId: "v1",
    appId: 999,
    emulator: EMULATOR,
    hostUserId: "host",
  });
  assert.equal(room.appId, 999);
  assert.equal((await store.list())[0]?.appId, 999);
});

test("RoomStore rotates credentials near expiry", async () => {
  const h = harness();
  const room = await h.store.create(createInput("host"));
  const first = await h.store.credential(room.id, "host");

  // Move to within the rotation window of the room's expiry.
  h.setNow(room.expiresAt - CREDENTIAL_ROTATION_WINDOW_MS + 1);
  const second = await h.store.credential(room.id, "host");
  assert.ok(second.issuedAt > first.issuedAt);
});

test("compatFromEnv parses blocked app and game lists", () => {
  const info = compatFromEnv({
    GSE_BLOCKED_APP_IDS: "1, 2, x",
    GSE_BLOCKED_GAME_IDS: "a, b",
  });
  assert.deepEqual(info.blockedAppIds, [1, 2]);
  assert.deepEqual(info.blockedGameIds, ["a", "b"]);
});
