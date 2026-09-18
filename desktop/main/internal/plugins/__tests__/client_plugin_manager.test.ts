import test from "node:test";
import assert from "node:assert/strict";
import { ClientPluginManager } from "../ClientPluginManager";
import { executeLaunchPipeline } from "../launch-pipeline";
import type {
  ClientPlugin,
  ClientPluginContext,
  CloudSavePathResolver,
  LaunchHook,
  MetadataProvider,
  StoreScanner,
} from "../types";

test("ClientPluginManager registers overlay slots without crashing", async () => {
  const manager = new ClientPluginManager();

  const overlayPlugin: ClientPlugin = {
    metadata: {
      id: "overlay-hud",
      name: "Overlay HUD",
      version: "1.0.0",
    },
    init(ctx: ClientPluginContext) {
      ctx.registerSlot("overlay:panel", { template: "<div>Panel</div>" });
      ctx.registerSlot("overlay:quick-access", {
        template: "<div>Access</div>",
      });
    },
  };

  await manager.registerPlugin(overlayPlugin, "overlay-hud", [], ["ui:slot"]);

  assert.equal(manager.slots["overlay:panel"].length, 1);
  assert.equal(manager.slots["overlay:panel"][0]?.pluginId, "overlay-hud");
  assert.equal(manager.slots["overlay:quick-access"].length, 1);
  assert.equal(
    manager.slots["overlay:quick-access"][0]?.pluginId,
    "overlay-hud",
  );

  await manager.unregisterPlugin("overlay-hud");
  assert.equal(manager.slots["overlay:panel"].length, 0);
  assert.equal(manager.slots["overlay:quick-access"].length, 0);
});

test("ClientPluginManager registers StoreScanner and MetadataProvider SPIs", async () => {
  const manager = new ClientPluginManager();

  const gogScanner: StoreScanner = {
    id: "gog",
    name: "GOG Galaxy",
    store: "gog",
    scan: async () => [
      {
        externalId: "gog-101",
        store: "gog",
        title: "Cyberpunk 2077",
        installPath: "/games/cyberpunk",
      },
    ],
  };

  const exampleMetadataProvider: MetadataProvider = {
    id: "example-metadata",
    name: "Example Metadata",
    search: async (query) => [
      { id: "meta-1", title: query, provider: "example-metadata" },
    ],
    getDetails: async (id) => ({
      id,
      title: "Super Mario World",
      provider: "example-metadata",
    }),
  };

  let unregisterScanner: (() => void) | undefined;
  let unregisterProvider: (() => void) | undefined;
  let unregisterCloudSave: (() => void) | undefined;

  const exampleCloudsaveResolver: CloudSavePathResolver = {
    id: "example-cloudsave",
    name: "Example Cloud Save",
    resolveSavePaths: async (gameContext) => [
      { pattern: `%APPDATA%/${gameContext.gameTitle}` },
    ],
  };

  const aggregatorPlugin: ClientPlugin = {
    metadata: {
      id: "aggregator",
      name: "Aggregator Plugin",
      version: "1.0.0",
    },
    init(ctx: ClientPluginContext) {
      unregisterScanner = ctx.registerStoreScanner(gogScanner);
      if (ctx.registerMetadataProvider) {
        unregisterProvider = ctx.registerMetadataProvider(
          exampleMetadataProvider,
        );
      }
      unregisterCloudSave = ctx.registerCloudSaveResolver?.(
        exampleCloudsaveResolver,
      );
    },
  };

  await manager.registerPlugin(
    aggregatorPlugin,
    "aggregator",
    [],
    ["client:library-scan", "metadata:provider", "cloudsave:provider"],
  );

  // Assert registered
  const scanners = manager.getStoreScanners();
  assert.equal(scanners.length, 1);
  const scanner = scanners[0];
  assert.ok(scanner);
  assert.equal(scanner.id, "gog");
  const games = await scanner.scan();
  assert.equal(games.length, 1);
  assert.equal(games[0]?.title, "Cyberpunk 2077");

  const providers = manager.getMetadataProviders();
  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.id, "example-metadata");

  const resolvers = manager.getCloudSaveResolvers();
  assert.equal(resolvers.length, 1);
  assert.equal(resolvers[0]?.id, "example-cloudsave");

  // Capability enforcement
  const restrictedPlugin: ClientPlugin = {
    metadata: {
      id: "restricted-client",
      name: "Restricted",
      version: "1.0.0",
    },
    init(ctx: ClientPluginContext) {
      ctx.registerStoreScanner({
        id: "epic",
        name: "Epic",
        store: "epic",
        scan: async () => [],
      });
    },
  };

  await manager.registerPlugin(
    restrictedPlugin,
    "restricted-client",
    [],
    ["ui:slot"],
  );
  // Registration should fail inside init and not add scanner
  assert.equal(manager.getStoreScanners().length, 1);

  // Manual unregister hooks work
  unregisterScanner?.();
  assert.equal(manager.getStoreScanners().length, 0);

  unregisterProvider?.();
  assert.equal(manager.getMetadataProviders().length, 0);

  unregisterCloudSave?.();
  assert.equal(manager.getCloudSaveResolvers().length, 0);
});

test("ClientPluginManager cleans up SPI entries and slots on unregisterPlugin", async () => {
  const manager = new ClientPluginManager();

  const multiPlugin: ClientPlugin = {
    metadata: {
      id: "multi-test",
      name: "Multi Test",
      version: "1.0.0",
    },
    init(ctx: ClientPluginContext) {
      ctx.registerSlot("overlay:panel", { template: "test" });
      ctx.registerStoreScanner({
        id: "scanner-1",
        name: "Scanner 1",
        store: "custom",
        scan: async () => [],
      });
      ctx.registerMetadataProvider?.({
        id: "meta-1",
        name: "Meta 1",
        search: async () => [],
        getDetails: async () => null,
      });
    },
  };

  await manager.registerPlugin(
    multiPlugin,
    "multi-test",
    [],
    ["ui:slot", "client:library-scan", "metadata:provider"],
  );

  assert.equal(manager.slots["overlay:panel"].length, 1);
  assert.equal(manager.getStoreScanners().length, 1);
  assert.equal(manager.getMetadataProviders().length, 1);

  await manager.unregisterPlugin("multi-test");

  assert.equal(manager.slots["overlay:panel"].length, 0);
  assert.equal(manager.getStoreScanners().length, 0);
  assert.equal(manager.getMetadataProviders().length, 0);
});

test("ClientPluginContext provides frozen settings snapshot", async () => {
  const manager = new ClientPluginManager();
  let capturedSettings: Readonly<Record<string, unknown>> | undefined;

  const pluginWithSettings: ClientPlugin = {
    metadata: {
      id: "settings-test",
      name: "Settings Test",
      version: "1.0.0",
    },
    init(ctx: ClientPluginContext) {
      capturedSettings = ctx.settings;
    },
  };

  await manager.registerPlugin(pluginWithSettings, "settings-test", [], []);
  assert.ok(capturedSettings);
  assert.equal(typeof capturedSettings, "object");
  assert.equal(Object.isFrozen(capturedSettings), true);

  await manager.unregisterPlugin("settings-test");
});

test("executeLaunchPipeline executes pre-launch:network-post in sequence", async () => {
  const executionOrder: string[] = [];
  const hooks: LaunchHook[] = [
    {
      stage: "pre-launch:network-post",
      order: 10,
      execute: async () => {
        executionOrder.push("network-post");
      },
    },
    {
      stage: "pre-launch:network",
      order: 0,
      execute: async () => {
        executionOrder.push("network");
      },
    },
    {
      stage: "pre-launch:validate",
      order: 0,
      execute: async () => {
        executionOrder.push("validate");
      },
    },
    {
      stage: "post-exit:cleanup",
      order: 0,
      execute: async () => {
        executionOrder.push("cleanup");
      },
    },
  ];

  const result = await executeLaunchPipeline(
    hooks,
    {
      gameId: "test-game",
      gameTitle: "Test Game",
      gameDir: "/games/test",
    },
    async () => {
      executionOrder.push("launch");
      return "launched-ok";
    },
  );

  assert.equal(result, "launched-ok");
  assert.deepEqual(executionOrder, [
    "validate",
    "network",
    "network-post",
    "launch",
    "cleanup",
  ]);
});

