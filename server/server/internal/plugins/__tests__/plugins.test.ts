import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { PluginManager } from "../manager";
import { DropGseServerPlugin } from "../builtin/drop-gse";
import type { PluginContext, PluginStorage, ServerPlugin } from "../types";

/**
 * In-memory storage so tests never touch Drop's runtime config (which is only
 * available inside a Nuxt/Nitro process).
 */
class MemoryStorage implements PluginStorage {
  private readonly data = new Map<string, unknown>();

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
}

let managerCounter = 0;

/** Build a manager isolated from the Nuxt runtime and the shared plugin dir. */
function createTestManager(): PluginManager {
  managerCounter += 1;
  return new PluginManager({
    dataDir: path.join(
      os.tmpdir(),
      `drop-plugin-test-${process.pid}-${managerCounter}-${Date.now()}`,
    ),
    storageFactory: () => new MemoryStorage(),
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
  const gsePlugin = new DropGseServerPlugin();
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

test("PluginManager capability sandboxing restricts undeclared capabilities", async () => {
  const manager = createTestManager();

  const noRoutesPlugin: ServerPlugin = {
    metadata: {
      id: "no-routes-plugin",
      name: "No Routes Plugin",
      version: "1.0.0",
      capabilities: ["storage"], // explicitly lacks "routes"
    },
    init: (ctx: PluginContext) => {
      ctx.registerRoute("GET", "/should-not-exist", () => {
        return { allowed: false };
      });
    },
  };

  await manager.registerPlugin(noRoutesPlugin);

  const mockEvent = {
    method: "GET",
    headers: new Headers(),
  } as unknown as import("h3").H3Event;

  await assert.rejects(
    async () => {
      await manager.dispatch(
        "no-routes-plugin",
        "GET",
        "/should-not-exist",
        mockEvent,
      );
    },
    { statusCode: 404 },
  );
});
