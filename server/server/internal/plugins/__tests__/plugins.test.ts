import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PluginManager } from "../manager";
import { HelloWorldPlugin } from "../builtin/hello-world";
import { PLUGIN_API_VERSION } from "../types";
import type {
  PluginCapability,
  PluginContext,
  PluginManifest,
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

test("PluginManager fails closed on system:command without a commands allowlist", async () => {
  const entryBase64 = Buffer.from("export default {}").toString("base64");

  await assert.rejects(
    () =>
      createTestManager().installBundle(
        {
          id: "native-demo",
          name: "Native",
          version: "1.0.0",
          apiVersion: PLUGIN_API_VERSION,
          targets: ["client"],
          client: { entry: "client.js", capabilities: ["system:command"] },
        },
        entryBase64,
      ),
    /client\.commands/,
  );

  await assert.rejects(
    () =>
      createTestManager().installBundle(
        {
          id: "native-demo-2",
          name: "Native",
          version: "1.0.0",
          apiVersion: PLUGIN_API_VERSION,
          targets: ["client"],
          client: {
            entry: "client.js",
            capabilities: ["system:command"],
            commands: ["/usr/bin/zerotier-cli"],
          },
        },
        entryBase64,
      ),
    /bare executable names/,
  );
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

  // Verify public channel registration
  assert.equal(manager.isPublicChannel("ws:test"), false);
  const publicPlugin: ServerPlugin = {
    metadata: {
      id: "public-ws-plugin",
      name: "Public WS Plugin",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["websocket"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerWebSocket("ws:public", () => {}, { public: true });
      ctx.registerPublicWebSocketChannel("ws:explicit-public");
    },
  };
  await manager.registerPlugin(publicPlugin);
  assert.equal(manager.isPublicChannel("ws:public"), true);
  assert.equal(manager.isPublicChannel("ws:explicit-public"), true);
  assert.equal(manager.isPublicChannel("ws:other"), false);

  await manager.unregisterPlugin("public-ws-plugin");
  assert.equal(manager.isPublicChannel("ws:public"), false);
  assert.equal(manager.isPublicChannel("ws:explicit-public"), false);

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

test("PluginRegistry supports remote HTTP registry with pinning, install-by-URL and updates", async () => {
  const entry =
    "export default { metadata: { id: 'remote-demo', name: 'Remote'," +
    " version: '2.0.0', apiVersion: 1, capabilities: ['routes'] }," +
    " init(ctx) { ctx.registerRoute('GET', '/r', () => ({ r: 1 })); } };\n";
  const entryBase64 = Buffer.from(entry).toString("base64");
  const checksum = createHash("sha256").update(entry).digest("hex");

  let serverPort = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/registry.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          plugins: [
            {
              id: "remote-demo",
              version: "2.0.0",
              checksum,
              downloadUrl: `http://127.0.0.1:${serverPort}/bundle.json`,
            },
          ],
        }),
      );
    } else if (req.url === "/bundle.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          manifest: {
            id: "remote-demo",
            name: "Remote",
            version: "2.0.0",
            apiVersion: PLUGIN_API_VERSION,
            capabilities: ["routes"],
            entry: "index.js",
            checksum,
          },
          entry: entryBase64,
        }),
      );
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        serverPort = addr.port;
      }
      resolve();
    });
  });

  try {
    const registryUrl = `http://127.0.0.1:${serverPort}/registry.json`;
    const dataDir = tmpDataDir();
    const manager = new PluginManager({
      dataDir,
      registryPath: registryUrl,
      storageFactory: () => new MemoryStorage(),
      authResolver: async () => ({}),
    });

    // 1. Install by URL
    await manager.installFromUrl(`http://127.0.0.1:${serverPort}/bundle.json`);
    const installed = manager.listPlugins().find((p) => p.id === "remote-demo");
    assert.equal(installed?.status, "active");
    assert.equal(installed?.version, "2.0.0");

    // 2. Unlisted or mismatched plugin rejected by remote registry
    await assert.rejects(
      () =>
        manager.installBundle(
          {
            id: "unlisted-plugin",
            name: "Unlisted",
            version: "1.0.0",
            apiVersion: PLUGIN_API_VERSION,
            capabilities: ["routes"],
            entry: "index.js",
          },
          entryBase64,
        ),
      /not in the registry/,
    );

    // 3. Update checking
    const updates = await manager.checkForUpdates();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].hasUpdate, false);

    // 4. Fail closed on 404 remote registry
    await assert.rejects(
      () =>
        new PluginManager({
          dataDir: tmpDataDir(),
          registryPath: `http://127.0.0.1:${serverPort}/nonexistent.json`,
          storageFactory: () => new MemoryStorage(),
          authResolver: async () => ({}),
        }).installBundle(
          {
            id: "remote-demo",
            name: "Remote",
            version: "2.0.0",
            apiVersion: PLUGIN_API_VERSION,
            capabilities: ["routes"],
            entry: "index.js",
            checksum,
          },
          entryBase64,
        ),
      /failed to fetch remote plugin registry/,
    );
  } finally {
    server.close();
  }
});

test("PluginManager strictly refuses unsigned bundles when DROP_PLUGIN_REQUIRE_SIGNATURE=true", async () => {
  const orig = process.env.DROP_PLUGIN_REQUIRE_SIGNATURE;
  process.env.DROP_PLUGIN_REQUIRE_SIGNATURE = "true";
  try {
    const manager = createTestManager();
    const entry =
      "export default { metadata: { id: 'unsigned-demo', name: 'Unsigned'," +
      " version: '1.0.0', apiVersion: 1, capabilities: ['routes'] }," +
      " init() {} };\n";
    const entryBase64 = Buffer.from(entry).toString("base64");
    const checksum = createHash("sha256").update(entry).digest("hex");

    await assert.rejects(
      () =>
        manager.installBundle(
          {
            id: "unsigned-demo",
            name: "Unsigned",
            version: "1.0.0",
            apiVersion: PLUGIN_API_VERSION,
            capabilities: ["routes"],
            entry: "index.js",
            checksum,
          },
          entryBase64,
        ),
      /bundle unsigned-demo is unsigned/,
    );
  } finally {
    if (orig !== undefined) {
      process.env.DROP_PLUGIN_REQUIRE_SIGNATURE = orig;
    } else {
      delete process.env.DROP_PLUGIN_REQUIRE_SIGNATURE;
    }
  }
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

test("PluginManager installs multi-file bundles with files map", async () => {
  const dataDir = tmpDataDir();
  const manager = new PluginManager({
    dataDir,
    storageFactory: () => new MemoryStorage(),
    authResolver: async () => ({}),
  });

  const helper = "export const val = 42;\n";
  const helperHash = createHash("sha256").update(helper).digest("hex");

  const entry =
    "import { val } from './helper.mjs';\n" +
    "export default { metadata: { id: 'multi-install-demo', name: 'Multi Install'," +
    " version: '1.0.0', apiVersion: 2, capabilities: ['routes'] }," +
    " init(ctx) { ctx.registerRoute('GET', '/check', () => ({ ok: val })); } };\n";
  const entryHash = createHash("sha256").update(entry).digest("hex");

  const filesMap = {
    "index.mjs": Buffer.from(entry).toString("base64"),
    "helper.mjs": Buffer.from(helper).toString("base64"),
  };

  await manager.installBundle(
    {
      id: "multi-install-demo",
      name: "Multi Install",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["routes"],
      entry: "index.mjs",
      checksum: entryHash,
      files: {
        "index.mjs": entryHash,
        "helper.mjs": helperHash,
      },
    },
    filesMap,
  );

  assert.equal(
    manager.listPlugins().find((p) => p.id === "multi-install-demo")?.status,
    "active",
  );

  // Rejects invalid file path escaping directory
  await assert.rejects(
    () =>
      manager.installBundle(
        {
          id: "escape-demo",
          name: "Escape",
          version: "1.0.0",
          apiVersion: PLUGIN_API_VERSION,
          capabilities: ["routes"],
        },
        {
          "../escaped.js": Buffer.from("console.log('escaped')").toString(
            "base64",
          ),
        },
      ),
    /invalid bundle file path/,
  );
});

test("PluginManager.canSubscribe enforces registered subscription authorizers", async () => {
  const manager = createTestManager();
  const plugin: ServerPlugin = {
    metadata: {
      id: "authz-demo",
      name: "Authz",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["websocket"],
    },
    init(ctx: PluginContext) {
      ctx.registerSubscriptionAuthorizer(
        (channel) => channel.startsWith("room:"),
        (_channel, context) => context.userId === "member",
      );
    },
  };
  await manager.registerPlugin(plugin);

  assert.equal(
    await manager.canSubscribe("room:1", {
      userId: "member",
      userAcls: undefined,
    }),
    true,
  );
  assert.equal(
    await manager.canSubscribe("room:1", {
      userId: "stranger",
      userAcls: undefined,
    }),
    false,
  );
  // Channels with no matching authorizer remain open.
  assert.equal(
    await manager.canSubscribe("unrelated", {
      userId: undefined,
      userAcls: undefined,
    }),
    true,
  );
});

test("a configured but empty registry denies external plugins", async () => {
  const dataDir = tmpDataDir();
  await fs.mkdir(dataDir, { recursive: true });
  const registryPath = path.join(dataDir, "registry.json");
  await fs.writeFile(registryPath, JSON.stringify({ plugins: null }));

  const manager = new PluginManager({
    dataDir,
    registryPath,
    storageFactory: () => new MemoryStorage(),
    authResolver: async () => ({}),
  });

  const entry =
    "export default { metadata: { id: 'denied-demo', name: 'Denied'," +
    " version: '1.0.0', apiVersion: 1 }, init() {} };\n";
  const entryBase64 = Buffer.from(entry).toString("base64");
  await assert.rejects(
    () =>
      manager.installBundle(
        {
          id: "denied-demo",
          name: "Denied",
          version: "1.0.0",
          apiVersion: PLUGIN_API_VERSION,
          entry: "index.js",
        },
        entryBase64,
      ),
    /not in the registry/,
  );
});

test("multi-file bundles must declare files checksums", async () => {
  const dataDir = tmpDataDir();
  const pluginDir = path.join(dataDir, "plugins", "multi-demo");
  await fs.mkdir(pluginDir, { recursive: true });
  const entry =
    "import { value } from './helper.mjs';\n" +
    "export default { metadata: { id: 'multi-demo', name: 'Multi'," +
    " version: '1.0.0', apiVersion: 1 }, init() { void value; } };\n";
  await fs.writeFile(path.join(pluginDir, "index.mjs"), entry);
  await fs.writeFile(
    path.join(pluginDir, "helper.mjs"),
    "export const value = 1;\n",
  );

  const manifest = {
    id: "multi-demo",
    name: "Multi",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    entry: "index.mjs",
  };
  await fs.writeFile(
    path.join(pluginDir, "drop-plugin.json"),
    JSON.stringify(manifest),
  );

  const manager = new PluginManager({
    dataDir,
    storageFactory: () => new MemoryStorage(),
    authResolver: async () => ({}),
  });
  await manager.discoverAndLoadExternalPlugins();
  assert.equal(
    manager.listPlugins().find((p) => p.id === "multi-demo"),
    undefined,
    "an unverified multi-file bundle must not load",
  );

  const files: Record<string, string> = {};
  for (const rel of ["index.mjs", "helper.mjs"]) {
    files[rel] = createHash("sha256")
      .update(await fs.readFile(path.join(pluginDir, rel)))
      .digest("hex");
  }
  await fs.writeFile(
    path.join(pluginDir, "drop-plugin.json"),
    JSON.stringify({ ...manifest, files }),
  );
  const manager2 = new PluginManager({
    dataDir,
    storageFactory: () => new MemoryStorage(),
    authResolver: async () => ({}),
  });
  await manager2.discoverAndLoadExternalPlugins();
  assert.equal(
    manager2.listPlugins().find((p) => p.id === "multi-demo")?.status,
    "active",
  );
});

test("sign-plugin output loads as a verified signed bundle", async () => {
  const dataDir = tmpDataDir();
  const pluginDir = path.join(dataDir, "plugins", "signed-demo");
  await fs.mkdir(pluginDir, { recursive: true });
  const entry =
    "import { value } from './helper.mjs';\n" +
    "export default { metadata: { id: 'signed-demo', name: 'Signed'," +
    " version: '1.0.0', apiVersion: 1 }, init() { void value; } };\n";
  await fs.writeFile(path.join(pluginDir, "index.mjs"), entry);
  await fs.writeFile(
    path.join(pluginDir, "helper.mjs"),
    "export const value = 1;\n",
  );
  await fs.writeFile(
    path.join(pluginDir, "drop-plugin.json"),
    JSON.stringify({
      id: "signed-demo",
      name: "Signed",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      entry: "index.mjs",
    }),
  );

  const here = path.dirname(fileURLToPath(import.meta.url));
  const signer = path.resolve(here, "../../../../dev-tools/sign-plugin.mjs");
  const signingKey = "test-signing-key";
  const signed = spawnSync(process.execPath, [signer, "plugins/signed-demo"], {
    cwd: dataDir,
    env: { ...process.env, DROP_PLUGIN_SIGNING_KEY: signingKey },
    encoding: "utf8",
  });
  assert.equal(signed.status, 0, signed.stderr);

  const previousKey = process.env.DROP_PLUGIN_SIGNING_KEY;
  process.env.DROP_PLUGIN_SIGNING_KEY = signingKey;
  try {
    const manager = new PluginManager({
      dataDir,
      storageFactory: () => new MemoryStorage(),
      authResolver: async () => ({}),
    });
    await manager.discoverAndLoadExternalPlugins();
    assert.equal(
      manager.listPlugins().find((p) => p.id === "signed-demo")?.status,
      "active",
      "a correctly signed bundle must load",
    );

    // Tampering an imported file must invalidate the aggregate signature.
    await fs.writeFile(
      path.join(pluginDir, "helper.mjs"),
      "export const value = 2;\n",
    );
    const tampered = new PluginManager({
      dataDir,
      storageFactory: () => new MemoryStorage(),
      authResolver: async () => ({}),
    });
    await tampered.discoverAndLoadExternalPlugins();
    assert.equal(
      tampered.listPlugins().find((p) => p.id === "signed-demo"),
      undefined,
      "a tampered imported file must not load",
    );
  } finally {
    if (previousKey === undefined) {
      delete process.env.DROP_PLUGIN_SIGNING_KEY;
    } else {
      process.env.DROP_PLUGIN_SIGNING_KEY = previousKey;
    }
  }
});

test("PluginManager supports manifest v2, client targets, and getClientAssetPath", async () => {
  const dataDir = tmpDataDir();
  const pluginDir = path.join(dataDir, "plugins", "client-asset-demo");
  await fs.mkdir(path.join(pluginDir, "client"), { recursive: true });

  const clientJs = "export default { render() {} };\n";
  const clientCss = ".custom-badge { color: red; }\n";
  await fs.writeFile(path.join(pluginDir, "client", "bundle.js"), clientJs);
  await fs.writeFile(path.join(pluginDir, "client", "bundle.css"), clientCss);

  const manifest = {
    id: "client-asset-demo",
    name: "Client Asset Demo",
    version: "1.0.0",
    apiVersion: 2,
    targets: ["client"],
    client: {
      entry: "client/bundle.js",
      css: "client/bundle.css",
      capabilities: ["ui:slot"],
    },
  };
  await fs.writeFile(
    path.join(pluginDir, "drop-plugin.json"),
    JSON.stringify(manifest),
  );

  const manager = new PluginManager({
    dataDir,
    storageFactory: () => new MemoryStorage(),
    authResolver: async () => ({}),
  });

  await manager.discoverAndLoadExternalPlugins();
  const plugins = manager.listPlugins();
  const found = plugins.find((p) => p.id === "client-asset-demo");
  assert.ok(found, "client-only plugin must be registered in plugin list");
  assert.equal(found.status, "active");

  // Verify getClientAssetPath resolves legitimate files
  const resolvedJs = await manager.getClientAssetPath(
    "client-asset-demo",
    "client/bundle.js",
  );
  assert.ok(resolvedJs);
  assert.equal(await fs.readFile(resolvedJs, "utf-8"), clientJs);

  const resolvedCss = await manager.getClientAssetPath(
    "client-asset-demo",
    "client/bundle.css",
  );
  assert.ok(resolvedCss);
  assert.equal(await fs.readFile(resolvedCss, "utf-8"), clientCss);

  // Path traversal escapes must return null
  const escaped = await manager.getClientAssetPath(
    "client-asset-demo",
    "../../_state.json",
  );
  assert.equal(escaped, null);
});

test("signed bundle with FilePluginStorage survives storage mutations and reload", async () => {
  const dataDir = tmpDataDir();
  const pluginDir = path.join(dataDir, "plugins", "storage-sign-demo");
  await fs.mkdir(pluginDir, { recursive: true });

  const entry =
    "export default { metadata: { id: 'storage-sign-demo', name: 'Storage Sign'," +
    " version: '1.0.0', apiVersion: 2, capabilities: ['routes', 'storage'] }," +
    " async init(ctx) { await ctx.storage.set('counter', 42); } };\n";
  await fs.writeFile(path.join(pluginDir, "index.mjs"), entry);
  await fs.writeFile(
    path.join(pluginDir, "drop-plugin.json"),
    JSON.stringify({
      id: "storage-sign-demo",
      name: "Storage Sign",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["routes", "storage"],
      entry: "index.mjs",
    }),
  );

  const here = path.dirname(fileURLToPath(import.meta.url));
  const signer = path.resolve(here, "../../../../dev-tools/sign-plugin.mjs");
  const signingKey = "test-storage-signing-key";
  const signed = spawnSync(
    process.execPath,
    [signer, "plugins/storage-sign-demo"],
    {
      cwd: dataDir,
      env: { ...process.env, DROP_PLUGIN_SIGNING_KEY: signingKey },
      encoding: "utf8",
    },
  );
  assert.equal(signed.status, 0, signed.stderr);

  const previousKey = process.env.DROP_PLUGIN_SIGNING_KEY;
  const previousRequire = process.env.DROP_PLUGIN_REQUIRE_SIGNATURE;
  process.env.DROP_PLUGIN_SIGNING_KEY = signingKey;
  process.env.DROP_PLUGIN_REQUIRE_SIGNATURE = "true";

  try {
    // 1. Initial load & execute init() which writes to storage
    const manager1 = new PluginManager({
      dataDir,
      authResolver: async () => ({}),
    });
    await manager1.discoverAndLoadExternalPlugins();
    assert.equal(
      manager1.listPlugins().find((p) => p.id === "storage-sign-demo")?.status,
      "active",
      "signed bundle must initialize cleanly on first load",
    );

    // Verify storage file was written outside plugins bundle directory (in plugin-data)
    const storageFile = path.join(
      dataDir,
      "plugin-data",
      "storage-sign-demo",
      "state.json",
    );
    assert.ok(
      await fs
        .access(storageFile)
        .then(() => true)
        .catch(() => false),
      "storage file must be in plugin-data",
    );

    // 2. Simulate server restart: new manager, reload plugins
    const manager2 = new PluginManager({
      dataDir,
      authResolver: async () => ({}),
    });
    await manager2.discoverAndLoadExternalPlugins();
    assert.equal(
      manager2.listPlugins().find((p) => p.id === "storage-sign-demo")?.status,
      "active",
      "signed bundle must remain active on reload after writing to storage",
    );
  } finally {
    if (previousKey === undefined) {
      delete process.env.DROP_PLUGIN_SIGNING_KEY;
    } else {
      process.env.DROP_PLUGIN_SIGNING_KEY = previousKey;
    }
    if (previousRequire === undefined) {
      delete process.env.DROP_PLUGIN_REQUIRE_SIGNATURE;
    } else {
      process.env.DROP_PLUGIN_REQUIRE_SIGNATURE = previousRequire;
    }
  }
});

test("PluginManager registers and gates MetadataProvider, CloudSavePathResolver, and PaymentGateway SPIs", async () => {
  const manager = createTestManager();

  const metadataPlugin: ServerPlugin = {
    metadata: {
      id: "steamgriddb-provider",
      name: "SteamGridDB",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["metadata:provider"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerMetadataProvider({
        id: "steamgriddb",
        name: "SteamGridDB",
        search: async (query) => [
          { id: "sgdb-1", title: query, provider: "steamgriddb" },
        ],
        getDetails: async (id) => ({
          id,
          title: "Sample Game",
          provider: "steamgriddb",
        }),
      });
    },
  };

  const paymentPlugin: ServerPlugin = {
    metadata: {
      id: "stripe-gateway",
      name: "Stripe Gateway",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["commerce:payment"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerPaymentGateway({
        id: "stripe",
        name: "Stripe",
        createPaymentIntent: async () => ({
          intentId: "pi_test_123",
          status: "pending",
        }),
        handleWebhook: async () => ({
          orderId: "ord_1",
          status: "succeeded",
          transactionId: "txn_1",
        }),
      });
    },
  };

  await manager.registerPlugin(metadataPlugin);
  await manager.registerPlugin(paymentPlugin);

  const cloudSavePlugin: ServerPlugin = {
    metadata: {
      id: "ludusavi-cloudsave",
      name: "Ludusavi Cloud Saves",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["cloudsave:provider"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerCloudSaveResolver({
        id: "ludusavi",
        name: "Ludusavi Manifest Resolver",
        resolveSavePaths: async (gameContext) => [
          { pattern: `%APPDATA%/${gameContext.gameTitle}/saves` },
        ],
      });
    },
  };
  await manager.registerPlugin(cloudSavePlugin);

  const resolvers = manager.getCloudSaveResolvers();
  assert.equal(resolvers.length, 1);
  assert.equal(resolvers[0].id, "ludusavi");
  assert.equal(
    manager.getCloudSaveResolver("ludusavi")?.name,
    "Ludusavi Manifest Resolver",
  );

  // Assert registered
  const providers = manager.getMetadataProviders();
  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, "steamgriddb");
  assert.equal(manager.getMetadataProvider("steamgriddb")?.name, "SteamGridDB");

  const gateways = manager.getPaymentGateways();
  assert.equal(gateways.length, 1);
  assert.equal(gateways[0].id, "stripe");
  assert.equal(manager.getPaymentGateway("stripe")?.name, "Stripe");

  // Collision rejection throws
  const collidingMetadataPlugin: ServerPlugin = {
    metadata: {
      id: "colliding-metadata-plugin",
      name: "Colliding Metadata",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["metadata:provider"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerMetadataProvider({
        id: "steamgriddb",
        name: "Fake SteamGridDB",
        search: async () => [],
        getDetails: async () => null,
      });
    },
  };

  await assert.rejects(
    () => manager.registerPlugin(collidingMetadataPlugin),
    /Metadata provider 'steamgriddb' is already claimed by plugin 'steamgriddb-provider'/,
  );

  const collidingPaymentPlugin: ServerPlugin = {
    metadata: {
      id: "colliding-payment-plugin",
      name: "Colliding Payment",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["commerce:payment"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerPaymentGateway({
        id: "stripe",
        name: "Fake Stripe",
        createPaymentIntent: async () => ({ intentId: "", status: "failed" }),
        handleWebhook: async () => ({
          orderId: "",
          status: "failed",
          transactionId: "",
        }),
      });
    },
  };

  await assert.rejects(
    () => manager.registerPlugin(collidingPaymentPlugin),
    /Payment gateway 'stripe' is already claimed by plugin 'stripe-gateway'/,
  );

  // Invalid ID throws
  const invalidIdPlugin: ServerPlugin = {
    metadata: {
      id: "invalid-id-plugin",
      name: "Invalid ID",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["metadata:provider"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerMetadataProvider({
        id: "   ",
        name: "Empty ID",
        search: async () => [],
        getDetails: async () => null,
      });
    },
  };

  await assert.rejects(
    () => manager.registerPlugin(invalidIdPlugin),
    /Metadata provider must have a valid non-empty id/,
  );

  // Capability violation throws
  const deniedPlugin: ServerPlugin = {
    metadata: {
      id: "denied-spi",
      name: "Denied SPI",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["routes"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerMetadataProvider({
        id: "denied",
        name: "Denied",
        search: async () => [],
        getDetails: async () => null,
      });
    },
  };

  await assert.rejects(
    () => manager.registerPlugin(deniedPlugin),
    /attempted 'registerMetadataProvider\(denied\)' without the 'metadata:provider' capability/,
  );

  // Cloud save resolver: collision, invalid id, and capability gate
  const collidingCloudSavePlugin: ServerPlugin = {
    metadata: {
      id: "colliding-cloudsave-plugin",
      name: "Colliding Cloud Save",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["cloudsave:provider"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerCloudSaveResolver({
        id: "ludusavi",
        name: "Fake Ludusavi",
        resolveSavePaths: async () => [],
      });
    },
  };

  await assert.rejects(
    () => manager.registerPlugin(collidingCloudSavePlugin),
    /Cloud save resolver 'ludusavi' is already claimed by plugin 'ludusavi-cloudsave'/,
  );

  const deniedCloudSavePlugin: ServerPlugin = {
    metadata: {
      id: "denied-cloudsave",
      name: "Denied Cloud Save",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["routes"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerCloudSaveResolver({
        id: "denied",
        name: "Denied",
        resolveSavePaths: async () => [],
      });
    },
  };

  await assert.rejects(
    () => manager.registerPlugin(deniedCloudSavePlugin),
    /attempted 'registerCloudSaveResolver\(denied\)' without the 'cloudsave:provider' capability/,
  );

  // Unregister cleans up SPI entries
  await manager.unregisterPlugin("steamgriddb-provider");
  assert.equal(manager.getMetadataProviders().length, 0);
  assert.equal(manager.getMetadataProvider("steamgriddb"), undefined);

  await manager.unregisterPlugin("ludusavi-cloudsave");
  assert.equal(manager.getCloudSaveResolvers().length, 0);
  assert.equal(manager.getCloudSaveResolver("ludusavi"), undefined);

  await manager.unregisterPlugin("stripe-gateway");
  assert.equal(manager.getPaymentGateways().length, 0);
  assert.equal(manager.getPaymentGateway("stripe"), undefined);
});

test("legacy files-only signatures still load after v2 support lands", async () => {
  const dataDir = tmpDataDir();
  const pluginDir = path.join(dataDir, "plugins", "legacy-signed");
  await fs.mkdir(pluginDir, { recursive: true });
  const entry =
    "export default { metadata: { id: 'legacy-signed', name: 'Legacy'," +
    " version: '1.0.0', apiVersion: 1 }, init() {} };\n";
  await fs.writeFile(path.join(pluginDir, "index.mjs"), entry);
  await fs.writeFile(
    path.join(pluginDir, "helper.mjs"),
    "export const value = 1;\n",
  );

  const files = ["helper.mjs", "index.mjs"].sort((a, b) => a.localeCompare(b));
  const aggregate = createHash("sha256");
  const fileChecksums: Record<string, string> = {};
  for (const rel of files) {
    const bytes = await fs.readFile(path.join(pluginDir, rel));
    fileChecksums[rel] = createHash("sha256").update(bytes).digest("hex");
    aggregate.update(rel);
    aggregate.update("\0");
    aggregate.update(String(bytes.length));
    aggregate.update("\0");
    aggregate.update(bytes);
  }
  // Test fixture: generate a random key per test run so it is not a hardcoded secret.
  const signingKey = randomBytes(32).toString("hex");
  const legacySignature = createHmac("sha256", signingKey)
    .update(aggregate.digest("hex"))
    .digest("hex");
  await fs.writeFile(
    path.join(pluginDir, "drop-plugin.json"),
    JSON.stringify({
      id: "legacy-signed",
      name: "Legacy",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      entry: "index.mjs",
      checksum: createHash("sha256").update(entry).digest("hex"),
      files: fileChecksums,
      signature: legacySignature,
    }),
  );

  const previousKey = process.env.DROP_PLUGIN_SIGNING_KEY;
  process.env.DROP_PLUGIN_SIGNING_KEY = signingKey;
  try {
    const manager = new PluginManager({
      dataDir,
      storageFactory: () => new MemoryStorage(),
      authResolver: async () => ({}),
    });
    await manager.discoverAndLoadExternalPlugins();
    assert.equal(
      manager.listPlugins().find((p) => p.id === "legacy-signed")?.status,
      "active",
      "a legacy files-only signature must still load",
    );
  } finally {
    if (previousKey === undefined) {
      delete process.env.DROP_PLUGIN_SIGNING_KEY;
    } else {
      process.env.DROP_PLUGIN_SIGNING_KEY = previousKey;
    }
  }
});

test("v2 signatures reject manifest tampering", async () => {
  const dataDir = tmpDataDir();
  const pluginDir = path.join(dataDir, "plugins", "manifest-tamper");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "index.mjs"),
    "export default { metadata: { id: 'manifest-tamper', name: 'Tamper'," +
      " version: '1.0.0', apiVersion: 1 }, init() {} };\n",
  );
  await fs.writeFile(
    path.join(pluginDir, "drop-plugin.json"),
    JSON.stringify({
      id: "manifest-tamper",
      name: "Tamper",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      entry: "index.mjs",
    }),
  );

  const here = path.dirname(fileURLToPath(import.meta.url));
  const signer = path.resolve(here, "../../../../dev-tools/sign-plugin.mjs");
  const signingKey = "manifest-tamper-key";
  const signed = spawnSync(
    process.execPath,
    [signer, "plugins/manifest-tamper"],
    {
      cwd: dataDir,
      env: { ...process.env, DROP_PLUGIN_SIGNING_KEY: signingKey },
      encoding: "utf8",
    },
  );
  assert.equal(signed.status, 0, signed.stderr);

  const manifestPath = path.join(pluginDir, "drop-plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  assert.equal(manifest.signatureVersion, 2);
  manifest.name = "Tampered";
  await fs.writeFile(manifestPath, JSON.stringify(manifest));

  const previousKey = process.env.DROP_PLUGIN_SIGNING_KEY;
  process.env.DROP_PLUGIN_SIGNING_KEY = signingKey;
  try {
    const manager = new PluginManager({
      dataDir,
      storageFactory: () => new MemoryStorage(),
      authResolver: async () => ({}),
    });
    await manager.discoverAndLoadExternalPlugins();
    assert.equal(
      manager.listPlugins().find((p) => p.id === "manifest-tamper"),
      undefined,
      "a tampered manifest must not load",
    );
  } finally {
    if (previousKey === undefined) {
      delete process.env.DROP_PLUGIN_SIGNING_KEY;
    } else {
      process.env.DROP_PLUGIN_SIGNING_KEY = previousKey;
    }
  }
});

test("plugin route patterns keep regex metacharacters literal", async () => {
  const manager = createTestManager();

  const regexPlugin: ServerPlugin = {
    metadata: {
      id: "regex-plugin",
      name: "Regex Plugin",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["routes"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerRoute("GET", "/literal/(a+)+", () => ({ literal: true }));
    },
  };

  await manager.registerPlugin(regexPlugin);

  const mockEvent = {
    method: "GET",
    headers: new Headers(),
  } as unknown as import("h3").H3Event;

  // The exact literal path matches...
  const literal = (await manager.dispatch(
    "regex-plugin",
    "GET",
    "/literal/(a+)+",
    mockEvent,
  )) as { literal: boolean };
  assert.equal(literal.literal, true);

  // ...but a path the metacharacters would match if compiled as a regex does not.
  await assert.rejects(
    () => manager.dispatch("regex-plugin", "GET", "/literal/aaaa", mockEvent),
    /No handler found/,
  );

  await manager.unregisterPlugin("regex-plugin");
});

test("PluginManager installs and executes a universal v2 .dropplugin package", async () => {
  const manager = createTestManager();

  const serverJs = `
    export default class UniversalPlugin {
      constructor() {
        this.metadata = {
          id: "universal-pkg",
          name: "Universal Package",
          version: "1.0.0",
          apiVersion: 2,
          capabilities: ["routes"],
        };
      }
      init(ctx) {
        ctx.registerRoute("GET", "/status", () => ({ ready: true }));
      }
    }
  `;
  const clientJs = `console.log("universal client bundle loaded");`;

  const serverDigest = createHash("sha256")
    .update(Buffer.from(serverJs))
    .digest("hex");
  const clientDigest = createHash("sha256")
    .update(Buffer.from(clientJs))
    .digest("hex");

  const filesMap: Record<string, string> = {
    "dist/server.js": Buffer.from(serverJs).toString("base64"),
    "dist/client.js": Buffer.from(clientJs).toString("base64"),
  };

  const droppluginPackage = {
    format: "dropplugin-v2",
    id: "universal-pkg",
    version: "1.0.0",
    manifest: {
      id: "universal-pkg",
      name: "Universal Package",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      targets: ["server", "client"],
      capabilities: ["routes"],
      server: {
        entry: "dist/server.js",
        capabilities: ["routes"],
      },
      client: {
        entry: "dist/client.js",
        capabilities: ["ui:slot"],
      },
      checksum: serverDigest,
      files: {
        "dist/server.js": serverDigest,
        "dist/client.js": clientDigest,
      },
    },
    files: filesMap,
  };

  // Install the packaged bundle map
  await manager.installBundle(
    droppluginPackage.manifest as unknown as PluginManifest,
    droppluginPackage.files,
  );

  // Assert registered and active
  const plugins = manager.listPlugins();
  const installed = plugins.find((p) => p.id === "universal-pkg");
  assert.ok(installed, "universal-pkg must be listed in plugins");
  assert.equal(installed.status, "active");

  // Assert server route works
  const mockEvent = {
    method: "GET",
    headers: new Headers(),
  } as unknown as import("h3").H3Event;

  const res = (await manager.dispatch(
    "universal-pkg",
    "GET",
    "/status",
    mockEvent,
  )) as { ready: boolean };
  assert.equal(res.ready, true);

  // Assert client asset can be served for desktop client
  const clientAsset = await manager.getClientAssetPath(
    "universal-pkg",
    "dist/client.js",
  );
  assert.ok(clientAsset, "client asset path must be resolvable");
  assert.ok(clientAsset.endsWith("dist/client.js"));
  const clientContent = await fs.readFile(clientAsset, "utf-8");
  assert.equal(clientContent, clientJs);

  await manager.unregisterPlugin("universal-pkg");
});

/* ============================== client.sidecars =========================== */

const SIDECAR_BYTES = Buffer.from("fake-gse-engine-binary");

function sidecarBundleFixture(overrides: {
  sidecars?: unknown[] | undefined;
  withFile?: boolean;
}) {
  const binaryBase64 = SIDECAR_BYTES.toString("base64");
  const binaryDigest = createHash("sha256").update(SIDECAR_BYTES).digest("hex");
  const serverEntry = `
    export default class SidecarDemoPlugin {
      constructor() {
        this.metadata = {
          id: "sidecar-demo",
          name: "Sidecar Demo",
          version: "1.0.0",
          apiVersion: 2,
          capabilities: ["routes"],
        };
      }
      init(ctx) { }
    }
`;
  const clientEntry = `console.log("sidecar-demo client bundle loaded");`;
  const serverDigest = createHash("sha256").update(serverEntry).digest("hex");
  const clientDigest = createHash("sha256").update(clientEntry).digest("hex");

  const manifest: Record<string, unknown> = {
    id: "sidecar-demo",
    name: "Sidecar Demo",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    targets: ["server", "client"],
    capabilities: ["routes", "game:launch-hook", "system:command"],
    server: { entry: "server.js", capabilities: ["routes"] },
    client: {
      entry: "client.js",
      capabilities: ["game:launch-hook", "system:command"],
      commands: ["gse-engine"],
      sidecars: overrides.sidecars,
    },
    files: {
      "server.js": serverDigest,
      "client.js": clientDigest,
      "sidecars/linux-x64/gse-engine": binaryDigest,
    },
  };

  const payload: Record<string, string> = {
    "server.js": Buffer.from(serverEntry).toString("base64"),
    "client.js": Buffer.from(clientEntry).toString("base64"),
  };
  if (overrides.withFile !== false) {
    payload["sidecars/linux-x64/gse-engine"] = binaryBase64;
  }
  return { manifest, payload };
}

test("PluginManager installs a bundle with a valid client.sidecars declaration", async () => {
  const manager = createTestManager();
  const { manifest, payload } = sidecarBundleFixture({
    sidecars: [
      {
        name: "gse-engine",
        targets: [
          {
            os: "linux",
            arch: "x64",
            path: "sidecars/linux-x64/gse-engine",
            sha256: createHash("sha256").update(SIDECAR_BYTES).digest("hex"),
          },
        ],
      },
    ],
  });

  await manager.installBundle(
    manifest as unknown as Parameters<PluginManager["installBundle"]>[0],
    payload,
  );
  const installed = manager.listPlugins().find((p) => p.id === "sidecar-demo");
  assert.equal(installed?.status, "active");

  // Sidecar binaries are servable via the existing client asset route.
  const asset = await manager.getClientAssetPath(
    "sidecar-demo",
    "sidecars/linux-x64/gse-engine",
  );
  assert.ok(asset, "sidecar binary must be resolvable");
});

test("PluginManager fails closed on sidecar sha256 mismatch", async () => {
  const manager = createTestManager();
  const { manifest, payload } = sidecarBundleFixture({
    sidecars: [
      {
        name: "gse-engine",
        targets: [
          {
            os: "linux",
            arch: "x64",
            path: "sidecars/linux-x64/gse-engine",
            sha256: "0".repeat(64),
          },
        ],
      },
    ],
  });

  await assert.rejects(
    () =>
      manager.installBundle(
        manifest as unknown as Parameters<PluginManager["installBundle"]>[0],
        payload,
      ),
    /sha256 mismatch/,
  );
});

test("PluginManager fails closed on undeclared sidecar paths and unlisted names", async () => {
  const digest = createHash("sha256").update(SIDECAR_BYTES).digest("hex");
  const manager = createTestManager();

  // Missing bundle file.
  const { manifest: missing, payload: missingPayload } = sidecarBundleFixture({
    sidecars: [
      {
        name: "gse-engine",
        targets: [
          {
            os: "linux",
            arch: "x64",
            path: "sidecars/windows-x64/gse-engine.exe",
            sha256: digest,
          },
        ],
      },
    ],
    withFile: false,
  });
  await assert.rejects(
    () =>
      manager.installBundle(
        missing as unknown as Parameters<PluginManager["installBundle"]>[0],
        missingPayload,
      ),
    /bundle manifest lists missing file|declared sidecar file missing|not covered/,
  );

  // Name not allowlisted.
  const { manifest: unlisted, payload: unlistedPayload } = sidecarBundleFixture(
    {
      sidecars: [
        {
          name: "not-allowlisted",
          targets: [
            {
              os: "linux",
              arch: "x64",
              path: "sidecars/linux-x64/gse-engine",
              sha256: digest,
            },
          ],
        },
      ],
    },
  );
  (unlisted.client as Record<string, unknown>).commands = ["other-tool"];
  await assert.rejects(
    () =>
      manager.installBundle(
        unlisted as unknown as Parameters<PluginManager["installBundle"]>[0],
        unlistedPayload,
      ),
    /must be allowlisted/,
  );
});
