import test from "node:test";
import assert from "node:assert/strict";
import { PluginManager } from "../manager";
import { DropGseServerPlugin } from "../builtin/drop-gse";
import type { PluginContext, ServerPlugin } from "../types";

test("PluginManager registers and initializes plugin", async () => {
  const manager = new PluginManager();
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
  const manager = new PluginManager();

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
  const manager = new PluginManager();
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
  const manager = new PluginManager();
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
