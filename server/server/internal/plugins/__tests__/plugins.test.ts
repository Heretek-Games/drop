import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginManager } from "../manager";
import { DropGseServerPlugin } from "../builtin/drop-gse";
import {
  InMemoryMeshBackend,
  roomCidr,
  roomMemberAddress,
} from "../builtin/gse/mesh";
import { ZtnetBackend } from "../builtin/gse/ztnet";
import { StorageRoomPersistence } from "../builtin/gse/persistence";
import { RoomStore } from "../builtin/gse/room-store";
import { HelloWorldPlugin } from "../builtin/hello-world";
import { PLUGIN_API_VERSION } from "../types";
import type {
  PluginCapability,
  PluginContext,
  PluginMetadata,
  PluginStorage,
  ServerPlugin,
} from "../types";

/**
 * In-memory storage so tests never touch Drop's runtime config (which is only
 * available inside a Nuxt/Nitro process).
 */
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

let managerCounter = 0;

function tmpDataDir(): string {
  managerCounter += 1;
  return path.join(
    os.tmpdir(),
    `drop-plugin-test-${process.pid}-${managerCounter}-${Date.now()}`,
  );
}

/** Build a manager isolated from the Nuxt runtime and the shared plugin dir. */
function createTestManager(storage?: PluginStorage): PluginManager {
  return new PluginManager({
    dataDir: tmpDataDir(),
    storageFactory: () => storage ?? new MemoryStorage(),
    authResolver: async () => ({ userId: undefined }),
  });
}

test("PluginManager registers and initializes plugin", async () => {
  const manager = createTestManager();
  let initCalled = false;

  const testPlugin: ServerPlugin = {
    metadata: {
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
    },
    init: (_ctx: PluginContext) => {
      initCalled = true;
    },
  };

  await manager.registerPlugin(testPlugin);

  assert.equal(initCalled, true);
  const list = manager.listPlugins();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "test-plugin");
  assert.equal(list[0].status, "active");
});

test("PluginManager route registration and pattern matching", async () => {
  const manager = createTestManager();

  const testPlugin: ServerPlugin = {
    metadata: {
      id: "route-plugin",
      name: "Route Plugin",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["routes"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerRoute("GET", "/items", () => {
        return { items: ["a", "b"] };
      });

      ctx.registerRoute("GET", "/items/:id", (_event, context) => {
        return { item: context.params.id };
      });

      ctx.registerRoute("POST", "/items/:id/action", (_event, context) => {
        return { action: "done", id: context.params.id };
      });
    },
  };

  await manager.registerPlugin(testPlugin);

  // Mock H3Event minimal shape
  const mockEvent = {
    method: "GET",
    headers: new Headers(),
  } as unknown as import("h3").H3Event;

  const res1 = (await manager.dispatch(
    "route-plugin",
    "GET",
    "/items",
    mockEvent,
  )) as { items: string[] };
  assert.deepEqual(res1.items, ["a", "b"]);

  const res2 = (await manager.dispatch(
    "route-plugin",
    "GET",
    "/items/123",
    mockEvent,
  )) as { item: string };
  assert.equal(res2.item, "123");

  const postEvent = {
    method: "POST",
    headers: new Headers(),
  } as unknown as import("h3").H3Event;

  const res3 = (await manager.dispatch(
    "route-plugin",
    "POST",
    "/items/456/action",
    postEvent,
  )) as { action: string; id: string };
  assert.equal(res3.action, "done");
  assert.equal(res3.id, "456");
});

test("PluginManager event bus broadcast and subscribe", async () => {
  const manager = createTestManager();
  let receivedMessage = "";

  const unsubscribe = manager.subscribe("chat:general", (data) => {
    receivedMessage = (data as { text: string }).text;
  });

  manager.broadcast("chat:general", { text: "hello world" });
  assert.equal(receivedMessage, "hello world");

  unsubscribe();
  manager.broadcast("chat:general", { text: "should not be received" });
  assert.equal(receivedMessage, "hello world");
});

test("DropGseServerPlugin rooms lifecycle", async () => {
  const manager = createTestManager();
  const gsePlugin = new DropGseServerPlugin(
    new StorageRoomPersistence(new MemoryStorage()),
  );
  await manager.registerPlugin(gsePlugin);

  const mockEvent = {
    method: "GET",
    headers: new Headers(),
  } as unknown as import("h3").H3Event;

  // Initially no rooms
  const list1 = (await manager.dispatch(
    "drop-gse",
    "GET",
    "/rooms",
    mockEvent,
  )) as { rooms: unknown[] };
  assert.equal(list1.rooms.length, 0);

  // Test teardown
  gsePlugin.teardown();
  const list2 = (await manager.dispatch(
    "drop-gse",
    "GET",
    "/rooms",
    mockEvent,
  )) as { rooms: unknown[] };
  assert.equal(list2.rooms.length, 0);
});

test("PluginManager togglePlugin enables and disables plugin lifecycle", async () => {
  const manager = createTestManager();

  const toggleTestPlugin: ServerPlugin = {
    metadata: {
      id: "toggle-test",
      name: "Toggle Test Plugin",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["routes"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerRoute("GET", "/ping", () => {
        return { pong: true };
      });
    },
    teardown: () => {},
  };

  await manager.registerPlugin(toggleTestPlugin);
  assert.equal(
    manager.listPlugins().find((p) => p.id === "toggle-test")?.status,
    "active",
  );

  const mockEvent = {
    method: "GET",
    headers: new Headers(),
  } as unknown as import("h3").H3Event;

  const resBefore = (await manager.dispatch(
    "toggle-test",
    "GET",
    "/ping",
    mockEvent,
  )) as { pong: boolean };
  assert.equal(resBefore.pong, true);

  // Disable plugin
  await manager.togglePlugin("toggle-test", false);
  assert.equal(
    manager.listPlugins().find((p) => p.id === "toggle-test")?.status,
    "disabled",
  );

  await assert.rejects(
    async () => {
      await manager.dispatch("toggle-test", "GET", "/ping", mockEvent);
    },
    { statusCode: 503 },
  );

  // Re-enable plugin
  await manager.togglePlugin("toggle-test", true);
  assert.equal(
    manager.listPlugins().find((p) => p.id === "toggle-test")?.status,
    "active",
  );

  const resAfter = (await manager.dispatch(
    "toggle-test",
    "GET",
    "/ping",
    mockEvent,
  )) as { pong: boolean };
  assert.equal(resAfter.pong, true);
});

test("PluginManager fails closed when using an undeclared capability", async () => {
  const manager = createTestManager();

  const noRoutesPlugin: ServerPlugin = {
    metadata: {
      id: "no-routes-plugin",
      name: "No Routes Plugin",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["storage"], // explicitly lacks "routes"
    },
    init: (ctx: PluginContext) => {
      ctx.registerRoute("GET", "/should-not-exist", () => ({
        allowed: false,
      }));
    },
  };

  await assert.rejects(() => manager.registerPlugin(noRoutesPlugin), {
    name: "PluginCapabilityError",
  });
  assert.equal(
    manager.listPlugins().find((p) => p.id === "no-routes-plugin")?.status,
    "error",
  );
});

test("PluginManager denies storage and network without capabilities", async () => {
  const manager = createTestManager();

  const plugin: ServerPlugin = {
    metadata: {
      id: "no-io-plugin",
      name: "No IO Plugin",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["routes"],
    },
    async init(ctx: PluginContext) {
      await assert.rejects(() => ctx.storage.get("x"), {
        name: "PluginCapabilityError",
      });
      await assert.rejects(() => ctx.fetch("https://example.com"), {
        name: "PluginCapabilityError",
      });
    },
  };

  await manager.registerPlugin(plugin);
  assert.equal(
    manager.listPlugins().find((p) => p.id === "no-io-plugin")?.status,
    "active",
  );
});

test("PluginManager defaults to denying capabilities when none are declared", async () => {
  const manager = createTestManager();

  for (const [id, capabilities] of [
    ["undeclared-plugin", undefined],
    ["empty-capabilities-plugin", [] as PluginCapability[]],
  ] as const) {
    const metadata: PluginMetadata = {
      id,
      name: id,
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
    };
    if (capabilities) metadata.capabilities = [...capabilities];
    const plugin: ServerPlugin = {
      metadata,
      init: (ctx: PluginContext) => {
        ctx.registerRoute("GET", "/denied", () => ({ allowed: false }));
      },
    };
    await assert.rejects(() => manager.registerPlugin(plugin), {
      name: "PluginCapabilityError",
    });
  }
});

test("PluginManager rejects plugin ids that escape the plugins directory", async () => {
  const manager = createTestManager();

  for (const id of ["..", ".", "../evil", "evil/../../x", ""]) {
    const plugin: ServerPlugin = {
      metadata: { id, name: "Evil", version: "1.0.0" },
      init: () => {},
    };
    await assert.rejects(
      () => manager.registerPlugin(plugin),
      /invalid plugin id/,
    );
  }

  await assert.rejects(() => manager.removeBundle(".."), /invalid plugin id/);

  await assert.rejects(
    () =>
      manager.installBundle(
        {
          id: "..",
          name: "Evil",
          version: "1.0.0",
          apiVersion: PLUGIN_API_VERSION,
        },
        Buffer.from("module.exports = {}").toString("base64"),
      ),
    /invalid plugin id/,
  );
});

test("PluginManager rejects incompatible plugin API versions", async () => {
  const manager = createTestManager();

  const plugin: ServerPlugin = {
    metadata: {
      id: "old-plugin",
      name: "Old",
      version: "1.0.0",
      apiVersion: 0,
    },
    init: () => {},
  };

  await assert.rejects(() => manager.registerPlugin(plugin), {
    name: "PluginApiVersionError",
  });

  const current: ServerPlugin = {
    metadata: {
      id: "current-plugin",
      name: "Current",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
    },
    init: () => {},
  };

  await manager.registerPlugin(current);
  assert.equal(
    manager.listPlugins().find((p) => p.id === "current-plugin")?.status,
    "active",
  );
});

test("PluginManager rejects unsupported trust tiers", async () => {
  const manager = createTestManager();

  const plugin: ServerPlugin = {
    metadata: {
      id: "sandboxed-plugin",
      name: "Sandboxed",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      trust: "sandboxed",
    },
    init: () => {},
  };

  await assert.rejects(() => manager.registerPlugin(plugin), {
    name: "PluginTrustError",
  });
});

test("PluginManager runs storage migrations to the declared version", async () => {
  const storage = new MemoryStorage();
  const manager = createTestManager(storage);
  const migrations: Array<[number, number]> = [];

  const plugin: ServerPlugin = {
    metadata: {
      id: "migrating-plugin",
      name: "Migrating",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["storage"],
      storageVersion: 2,
    },
    init: () => {},
    migrateStorage: async (from, to, target) => {
      migrations.push([from, to]);
      await target.set("migrated", true);
    },
  };

  await manager.registerPlugin(plugin);
  assert.deepEqual(migrations, [[0, 2]]);
  assert.equal(await storage.getSchemaVersion(), 2);

  // Re-registering must not re-run migrations.
  await manager.registerPlugin(plugin);
  assert.deepEqual(migrations, [[0, 2]]);
});

test("HelloWorldPlugin proves the platform is not GSE-shaped", async () => {
  const manager = createTestManager();
  await manager.registerPlugin(new HelloWorldPlugin());

  const mockEvent = {
    method: "GET",
    headers: new Headers(),
  } as unknown as import("h3").H3Event;

  const res = (await manager.dispatch(
    "hello-world",
    "GET",
    "/ping",
    mockEvent,
  )) as { pong: boolean };
  assert.equal(res.pong, true);
});

test("drop-gse distributes credentials over the authenticated WebSocket", async () => {
  const storage = new MemoryStorage();
  const seed = new RoomStore(
    new StorageRoomPersistence(storage),
    new InMemoryMeshBackend(),
    () => Date.now(),
  );
  const room = await seed.create({
    gameId: "game-1",
    versionId: "v1",
    emulator: {
      flavor: "gbe_fork",
      release: "latest",
      releaseDigest: "sha256-default",
    },
    hostUserId: "user-1",
  });

  const manager = new PluginManager({
    dataDir: tmpDataDir(),
    storageFactory: () => storage,
    authResolver: async () => ({}),
  });
  await manager.registerPlugin(
    new DropGseServerPlugin(new StorageRoomPersistence(storage)),
  );

  const sent: unknown[] = [];
  const handled = await manager.dispatchWebSocket(
    "gse:credential",
    { roomId: room.id },
    { userId: "user-1", send: (data) => sent.push(data) },
  );
  assert.equal(handled, true);
  const reply = sent[0] as {
    ok: boolean;
    credential?: { secret: string; address?: string };
  };
  assert.equal(reply.ok, true);
  assert.ok(reply.credential?.secret);
  assert.ok(reply.credential?.address);

  // Unauthenticated peers are refused.
  const refused: unknown[] = [];
  await manager.dispatchWebSocket(
    "gse:credential",
    { roomId: room.id },
    { userId: undefined, send: (data) => refused.push(data) },
  );
  assert.equal((refused[0] as { ok: boolean }).ok, false);
});

/** Minimal H3Event with a JSON body, enough for readBody/getQuery/dispatch. */
function jsonEvent(method: string, url: string, body?: unknown) {
  return {
    method,
    path: url,
    headers: new Headers({ "content-type": "application/json" }),
    node: {
      req: { headers: { "content-type": "application/json" }, url },
    },
    _requestBody: body,
  } as unknown as import("h3").H3Event;
}

test("drop-gse member report authorizes the ZeroTier node and returns its address", async () => {
  const storage = new MemoryStorage();
  const calls: string[] = [];
  const backend = new ZtnetBackend({
    baseUrl: "http://ztnet:3000",
    apiToken: "org-token",
    organizationId: "org-1",
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST" && url.endsWith("/network")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ nwid: "8056c2e21c000001" }),
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: init?.method === "DELETE" ? 204 : 200,
        json: async () => ({}),
        text: async () => "",
      };
    },
  });

  // Authenticated as user-1 for every dispatched route.
  const manager = new PluginManager({
    dataDir: tmpDataDir(),
    storageFactory: () => storage,
    authResolver: async () => ({ userId: "user-1" }),
  });
  await manager.registerPlugin(
    new DropGseServerPlugin(new StorageRoomPersistence(storage), backend),
  );

  const backendInfo = (await manager.dispatch(
    "drop-gse",
    "GET",
    "/backend",
    jsonEvent("GET", "/backend"),
  )) as { backend: string; memory: boolean };
  assert.equal(backendInfo.backend, "zerotier");
  assert.equal(backendInfo.memory, false);

  const created = (await manager.dispatch(
    "drop-gse",
    "POST",
    "/rooms",
    jsonEvent("POST", "/rooms", { gameId: "game-zt", versionId: "v1" }),
  )) as { room: { id: string; members: Array<{ meshAddress?: string }> } };

  const memberId = "abcdef0123";
  const reported = (await manager.dispatch(
    "drop-gse",
    "POST",
    `/rooms/${created.room.id}/member`,
    jsonEvent("POST", `/rooms/${created.room.id}/member`, { memberId }),
  )) as {
    room: { members: Array<{ userId: string; meshAddress?: string }> };
    address?: string;
  };

  const expected = roomMemberAddress(roomCidr(created.room.id), memberId);
  assert.ok(expected, "deterministic address should be derivable");
  assert.equal(reported.address, expected);
  assert.equal(
    reported.room.members.find((member) => member.userId === "user-1")
      ?.meshAddress,
    expected,
  );
  assert.ok(
    calls.some((call) => call.includes(`/member/${memberId}`)),
    "the controller must be asked to authorize the node",
  );
});

test("drop-gse route lifecycle: host, join, credential, member, leave, close", async () => {
  const storage = new MemoryStorage();
  let currentUser = "host";
  const manager = new PluginManager({
    dataDir: tmpDataDir(),
    storageFactory: () => storage,
    authResolver: async () => ({ userId: currentUser }),
  });
  await manager.registerPlugin(
    new DropGseServerPlugin(
      new StorageRoomPersistence(storage),
      new InMemoryMeshBackend(),
    ),
  );

  const broadcasts: Record<string, unknown>[] = [];
  manager.subscribe("gse:rooms", (event) => {
    broadcasts.push(event as Record<string, unknown>);
  });

  const created = (await manager.dispatch(
    "drop-gse",
    "POST",
    "/rooms",
    jsonEvent("POST", "/rooms", { gameId: "game-e2e", versionId: "v1" }),
  )) as { room: { id: string } };
  const roomId = created.room.id;

  // A different authenticated user joins.
  currentUser = "guest";
  const joined = (await manager.dispatch(
    "drop-gse",
    "POST",
    `/rooms/${roomId}/join`,
    jsonEvent("POST", `/rooms/${roomId}/join`),
  )) as { room: { members: Array<{ userId: string }> } };
  assert.equal(joined.room.members.length, 2);

  const credentialed = (await manager.dispatch(
    "drop-gse",
    "POST",
    `/rooms/${roomId}/credential`,
    jsonEvent("POST", `/rooms/${roomId}/credential`),
  )) as { credential: { secret: string; address?: string } };
  assert.ok(credentialed.credential.secret);

  const reported = (await manager.dispatch(
    "drop-gse",
    "POST",
    `/rooms/${roomId}/member`,
    jsonEvent("POST", `/rooms/${roomId}/member`, { memberId: "abcdef0123" }),
  )) as { address?: string };
  assert.ok(reported.address);

  // A non-member sees only the redacted discovery view.
  currentUser = "stranger";
  const discovery = (await manager.dispatch(
    "drop-gse",
    "GET",
    `/rooms/${roomId}`,
    jsonEvent("GET", `/rooms/${roomId}`),
  )) as { room: { hostUserId?: string; mesh: { networkId?: string } } };
  assert.equal(discovery.room.hostUserId, undefined);
  assert.equal(discovery.room.mesh.networkId, "");

  // Guest leaves; the host then closes the room.
  currentUser = "guest";
  const left = (await manager.dispatch(
    "drop-gse",
    "DELETE",
    `/rooms/${roomId}`,
    jsonEvent("DELETE", `/rooms/${roomId}`),
  )) as { closed: boolean };
  assert.equal(left.closed, false);

  // The leave broadcast must use the redacted discovery view: no network id
  // and no member identities on the public channel.
  const leaveUpdate = broadcasts
    .filter((event) => event.type === "room_updated")
    .at(-1) as {
    room: {
      mesh?: { networkId?: string };
      members?: unknown;
      memberCount?: number;
    };
  };
  assert.equal(leaveUpdate.room.mesh?.networkId, "");
  assert.equal(leaveUpdate.room.members, undefined);
  assert.equal(typeof leaveUpdate.room.memberCount, "number");

  currentUser = "host";
  const closed = (await manager.dispatch(
    "drop-gse",
    "DELETE",
    `/rooms/${roomId}`,
    jsonEvent("DELETE", `/rooms/${roomId}`),
  )) as { closed: boolean };
  assert.equal(closed.closed, true);

  const listed = (await manager.dispatch(
    "drop-gse",
    "GET",
    "/rooms",
    jsonEvent("GET", "/rooms"),
  )) as { rooms: unknown[] };
  assert.equal(listed.rooms.length, 0);
});

test("drop-gse backend selection honors GSE_MESH_BACKEND", async () => {
  const saved = {
    GSE_MESH_BACKEND: process.env.GSE_MESH_BACKEND,
    GSE_ZTNET_URL: process.env.GSE_ZTNET_URL,
    GSE_ZTNET_TOKEN: process.env.GSE_ZTNET_TOKEN,
    GSE_ZTNET_ORG: process.env.GSE_ZTNET_ORG,
  };
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  };
  const backendOf = async () => {
    const manager = createTestManager();
    await manager.registerPlugin(
      new DropGseServerPlugin(new StorageRoomPersistence(new MemoryStorage())),
    );
    return (await manager.dispatch(
      "drop-gse",
      "GET",
      "/backend",
      jsonEvent("GET", "/backend"),
    )) as { backend: string; memory: boolean };
  };

  try {
    // Explicit `memory` wins even when ZTNET credentials are present.
    process.env.GSE_MESH_BACKEND = "memory";
    process.env.GSE_ZTNET_URL = "http://ztnet:3000";
    process.env.GSE_ZTNET_TOKEN = "t";
    process.env.GSE_ZTNET_ORG = "o";
    assert.deepEqual(await backendOf(), { backend: "zerotier", memory: true });

    process.env.GSE_MESH_BACKEND = "ztnet";
    assert.deepEqual(await backendOf(), { backend: "zerotier", memory: false });

    // Unknown or under-configured explicit values fail closed.
    process.env.GSE_MESH_BACKEND = "bogus";
    await assert.rejects(() => backendOf(), /GSE_MESH_BACKEND/);

    process.env.GSE_MESH_BACKEND = "tailscale";
    await assert.rejects(() => backendOf(), /GSE_MESH_BACKEND/);
  } finally {
    restore();
  }
});

test("PluginManager routes WebSocket messages and enforces the capability", async () => {
  const manager = createTestManager();
  let received: unknown;

  const plugin: ServerPlugin = {
    metadata: {
      id: "ws-plugin",
      name: "WS Plugin",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["websocket"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerWebSocket("ws:test", (message, socket) => {
        received = message;
        socket.send({ ok: true });
      });
    },
  };
  await manager.registerPlugin(plugin);

  const sent: unknown[] = [];
  const handled = await manager.dispatchWebSocket(
    "ws:test",
    { hello: 1 },
    { send: (data) => sent.push(data) },
  );
  assert.equal(handled, true);
  assert.deepEqual(received, { hello: 1 });
  assert.deepEqual(sent, [{ ok: true }]);
  assert.equal(
    await manager.dispatchWebSocket("ws:missing", {}, { send: () => {} }),
    false,
  );

  // Missing capability fails closed at registration.
  const bad: ServerPlugin = {
    metadata: {
      id: "no-ws",
      name: "No WS",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["routes"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerWebSocket("x", () => {});
    },
  };
  await assert.rejects(() => manager.registerPlugin(bad), {
    name: "PluginCapabilityError",
  });
});

test("discovery verifies external bundle checksums", async () => {
  const dataDir = tmpDataDir();
  const pluginDir = path.join(dataDir, "plugins", "external-demo");
  await fs.mkdir(pluginDir, { recursive: true });

  const entry =
    "export default { metadata: { id: 'external-demo', name: 'External Demo'," +
    " version: '1.0.0', apiVersion: 1, capabilities: ['routes'] }," +
    " init(ctx) { ctx.registerRoute('GET', '/hello', () => ({ ok: true })); } };\n";
  const entryPath = path.join(pluginDir, "index.mjs");
  await fs.writeFile(entryPath, entry);
  const checksum = createHash("sha256").update(entry).digest("hex");
  await fs.writeFile(
    path.join(pluginDir, "drop-plugin.json"),
    JSON.stringify({
      id: "external-demo",
      name: "External Demo",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["routes"],
      entry: "index.mjs",
      checksum,
    }),
  );

  const manager = new PluginManager({
    dataDir,
    storageFactory: () => new MemoryStorage(),
    authResolver: async () => ({}),
  });
  await manager.discoverAndLoadExternalPlugins();
  assert.equal(
    manager.listPlugins().find((p) => p.id === "external-demo")?.status,
    "active",
  );

  // Tamper with the entry: the checksum mismatch must skip the bundle.
  await fs.writeFile(entryPath, `${entry}// tampered\n`);
  const manager2 = new PluginManager({
    dataDir,
    storageFactory: () => new MemoryStorage(),
    authResolver: async () => ({}),
  });
  await manager2.discoverAndLoadExternalPlugins();
  assert.equal(
    manager2.listPlugins().find((p) => p.id === "external-demo"),
    undefined,
  );
});

test("PluginRegistry enforces the allow-list and version pinning", async () => {
  const dataDir = tmpDataDir();
  await fs.mkdir(dataDir, { recursive: true });
  const registryPath = path.join(dataDir, "registry.json");

  const entry =
    "export default { metadata: { id: 'pinned-demo', name: 'Pinned'," +
    " version: '2.0.0', apiVersion: 1, capabilities: ['routes'] }," +
    " init(ctx) { ctx.registerRoute('GET', '/x', () => ({ x: 1 })); } };\n";
  const entryBase64 = Buffer.from(entry).toString("base64");
  const checksum = createHash("sha256").update(entry).digest("hex");

  await fs.writeFile(
    registryPath,
    JSON.stringify({
      plugins: [{ id: "pinned-demo", version: "2.0.0", checksum }],
    }),
  );

  const make = (dir: string) =>
    new PluginManager({
      dataDir: dir,
      registryPath,
      storageFactory: () => new MemoryStorage(),
      authResolver: async () => ({}),
    });

  // Pinned id/version/checksum: allowed.
  const manager = make(dataDir);
  await manager.installBundle(
    {
      id: "pinned-demo",
      name: "Pinned",
      version: "2.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["routes"],
      entry: "index.js",
      checksum,
    },
    entryBase64,
  );
  assert.equal(
    manager.listPlugins().find((p) => p.id === "pinned-demo")?.status,
    "active",
  );

  // Unlisted plugin: rejected.
  await assert.rejects(
    () =>
      make(tmpDataDir()).installBundle(
        {
          id: "not-listed",
          name: "N",
          version: "1.0.0",
          apiVersion: PLUGIN_API_VERSION,
          capabilities: ["routes"],
          entry: "index.js",
        },
        entryBase64,
      ),
    /not in the registry/,
  );

  // Wrong version: rejected.
  await assert.rejects(
    () =>
      make(tmpDataDir()).installBundle(
        {
          id: "pinned-demo",
          name: "Pinned",
          version: "1.0.0",
          apiVersion: PLUGIN_API_VERSION,
          capabilities: ["routes"],
          entry: "index.js",
          checksum,
        },
        entryBase64,
      ),
    /version/,
  );
});

test("PluginManager installs and removes external bundles", async () => {
  const dataDir = tmpDataDir();
  const manager = new PluginManager({
    dataDir,
    storageFactory: () => new MemoryStorage(),
    authResolver: async () => ({}),
  });

  const entry =
    "export default { metadata: { id: 'installed-demo', name: 'Installed'," +
    " version: '1.0.0', apiVersion: 1, capabilities: ['routes'] }," +
    " init(ctx) { ctx.registerRoute('GET', '/x', () => ({ x: 1 })); } };\n";
  const entryBase64 = Buffer.from(entry).toString("base64");
  const checksum = createHash("sha256").update(entry).digest("hex");

  await manager.installBundle(
    {
      id: "installed-demo",
      name: "Installed",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["routes"],
      entry: "index.js",
      checksum,
    },
    entryBase64,
  );
  assert.equal(
    manager.listPlugins().find((p) => p.id === "installed-demo")?.status,
    "active",
  );

  // A tampered/incorrect checksum is rejected before anything is written.
  await assert.rejects(
    () =>
      manager.installBundle(
        {
          id: "bad-demo",
          name: "Bad",
          version: "1.0.0",
          apiVersion: PLUGIN_API_VERSION,
          capabilities: ["routes"],
          entry: "index.js",
          checksum: "deadbeef",
        },
        entryBase64,
      ),
    /checksum/,
  );

  await manager.removeBundle("installed-demo");
  assert.equal(
    manager.listPlugins().find((p) => p.id === "installed-demo"),
    undefined,
  );

  // Builtin plugins cannot be removed.
  await manager.registerPlugin(new HelloWorldPlugin());
  await assert.rejects(() => manager.removeBundle("hello-world"), /builtin/);
});
