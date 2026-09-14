import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginManager } from "../manager";
import {
  PLUGIN_API_VERSION,
  type ServerPlugin,
  type PluginContext,
} from "../types";

function tmpDataDir(): string {
  const prefix = path.join(
    os.tmpdir(),
    `drop-upstream-compat-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  return prefix;
}

test("Upstream Invariant: Zero-plugin baseline leaves server in pure vanilla state", async (t) => {
  const dataDir = tmpDataDir();
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const manager = new PluginManager({ dataDir });

  // 1. Initial inventory must be completely empty
  const plugins = manager.listPlugins();
  assert.equal(
    plugins.length,
    0,
    "Default plugin list should be empty when no plugins are installed",
  );

  // 2. No routes or websockets registered
  assert.equal(
    manager.webSocketChannels().length,
    0,
    "No WebSocket channels should exist by default",
  );
  assert.equal(
    manager.publicWebSocketChannels().length,
    0,
    "No public channels should exist by default",
  );

  // 3. Dispatching to nonexistent plugin fails with 404
  await assert.rejects(
    () => manager.dispatch("nonexistent", "GET", "/test", {} as never),
    (err: unknown) => (err as { statusCode?: number })?.statusCode === 404,
    "Dispatch to missing plugin must reject with 404",
  );

  // 4. Checking updates on zero plugins yields empty list
  const updates = await manager.checkForUpdates();
  assert.deepEqual(
    updates,
    [],
    "Zero installed plugins must yield zero update notifications",
  );
});

test("Upstream Invariant: Dynamic public WebSocket channels function without hardcoded core identifiers", async (t) => {
  const dataDir = tmpDataDir();
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const manager = new PluginManager({ dataDir });

  const communityLobbyPlugin: ServerPlugin = {
    metadata: {
      id: "community-lobby",
      name: "Community Lobby Provider",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["websocket"],
    },
    init: (ctx: PluginContext) => {
      // Register public channel via options
      ctx.registerWebSocket(
        "community:lobbies",
        (msg, wsCtx) => {
          wsCtx.send({ echo: msg });
        },
        { public: true },
      );

      // Register public channel explicitly
      ctx.registerPublicWebSocketChannel("community:announcements");

      // Register authenticated channel
      ctx.registerWebSocket("community:private-chat", () => {});
    },
  };

  await manager.registerPlugin(communityLobbyPlugin);

  // Public channels are accessible without auth
  assert.equal(manager.isPublicChannel("community:lobbies"), true);
  assert.equal(manager.isPublicChannel("community:announcements"), true);
  assert.equal(manager.isPublicChannel("community:private-chat"), false);
  assert.equal(
    manager.isPublicChannel("gse:rooms"),
    false,
    "gse:rooms must not be hardcoded as public",
  );

  // Unregistering cleanly wipes out public channel designations
  await manager.unregisterPlugin("community-lobby");
  assert.equal(manager.isPublicChannel("community:lobbies"), false);
  assert.equal(manager.isPublicChannel("community:announcements"), false);
});

test("Upstream Invariant: Plugin lifecycle isolation leaves zero residual state upon uninstall", async (t) => {
  const dataDir = tmpDataDir();
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const manager = new PluginManager({ dataDir });

  let eventCount = 0;
  const samplePlugin: ServerPlugin = {
    metadata: {
      id: "lifecycle-isolated",
      name: "Lifecycle Isolated Plugin",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: ["routes", "websocket", "events", "storage"],
    },
    init: (ctx: PluginContext) => {
      ctx.registerRoute("GET", "/ping", () => ({ status: "ok" }));
      ctx.registerWebSocket("isolated:ws", () => {}, { public: true });
      ctx.subscribe("core:ping", () => {
        eventCount++;
      });
    },
  };

  await manager.registerPlugin(samplePlugin);
  assert.equal(manager.listPlugins().length, 1);
  assert.equal(manager.isPublicChannel("isolated:ws"), true);

  // Broadcast event received
  manager.broadcast("core:ping", {});
  assert.equal(eventCount, 1);

  // Unregister plugin
  await manager.unregisterPlugin("lifecycle-isolated");

  // Verify zero residue
  assert.equal(manager.listPlugins().length, 0);
  assert.equal(manager.isPublicChannel("isolated:ws"), false);
  assert.equal(manager.webSocketChannels().includes("isolated:ws"), false);

  // Further broadcasts are not received
  manager.broadcast("core:ping", {});
  assert.equal(
    eventCount,
    1,
    "Unregistered plugin must not receive subsequent broadcasts",
  );
});
