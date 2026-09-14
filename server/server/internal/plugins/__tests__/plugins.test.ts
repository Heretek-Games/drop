import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PluginManager } from "../manager";
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
