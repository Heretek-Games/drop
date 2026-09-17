import test from "node:test";
import assert from "node:assert/strict";
import { ClientPluginManager } from "../ClientPluginManager";
import type {
  ClientPlugin,
  ClientPluginContext,
  CloudSavePathResolver,
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

  const screenscraperProvider: MetadataProvider = {
    id: "screenscraper",
    name: "ScreenScraper",
    search: async (query) => [
      { id: "ss-1", title: query, provider: "screenscraper" },
    ],
    getDetails: async (id) => ({
      id,
      title: "Super Mario World",
      provider: "screenscraper",
    }),
  };

  let unregisterScanner: (() => void) | undefined;
  let unregisterProvider: (() => void) | undefined;
  let unregisterCloudSave: (() => void) | undefined;

  const ludusaviResolver: CloudSavePathResolver = {
    id: "ludusavi",
    name: "Ludusavi",
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
          screenscraperProvider,
        );
      }
      unregisterCloudSave = ctx.registerCloudSaveResolver?.(ludusaviResolver);
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
  assert.equal(providers[0]?.id, "screenscraper");

  const resolvers = manager.getCloudSaveResolvers();
  assert.equal(resolvers.length, 1);
  assert.equal(resolvers[0]?.id, "ludusavi");

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

test("ClientPluginManager executes launch pipeline in stage order and runs post-exit hooks", async () => {
  const manager = new ClientPluginManager();
  const stagesExecuted: string[] = [];

  const hookPlugin: ClientPlugin = {
    metadata: {
      id: "pipeline-hooks",
      name: "Pipeline Hooks",
      version: "1.0.0",
    },
    init(ctx: ClientPluginContext) {
      ctx.registerLaunchHook({
        stage: "pre-launch:validate",
        order: 10,
        execute: () => {
          stagesExecuted.push("validate:10");
        },
      });
      ctx.registerLaunchHook({
        stage: "pre-launch:validate",
        order: 1,
        execute: () => {
          stagesExecuted.push("validate:1");
        },
      });
      ctx.registerLaunchHook({
        stage: "pre-launch:prepare",
        execute: () => {
          stagesExecuted.push("prepare");
        },
      });
      ctx.registerLaunchHook({
        stage: "post-exit:cleanup",
        execute: () => {
          stagesExecuted.push("cleanup");
        },
      });
    },
  };

  await manager.registerPlugin(
    hookPlugin,
    "pipeline-hooks",
    [],
    ["game:launch-hook"],
  );

  const context = {
    gameId: "game-42",
    gameTitle: "Test Adventure",
    gameDir: "/tmp/test-game",
  };

  const result = await manager.executeLaunchPipeline(context, async () => {
    stagesExecuted.push("launched");
    return "ok-launched";
  });

  assert.equal(result, "ok-launched");
  assert.deepEqual(stagesExecuted, [
    "validate:1",
    "validate:10",
    "prepare",
    "launched",
    "cleanup",
  ]);
});

test("ClientPluginManager pre-launch failure aborts launch and rolls back completed stages", async () => {
  const manager = new ClientPluginManager();
  const stagesExecuted: string[] = [];

  const failingPlugin: ClientPlugin = {
    metadata: {
      id: "failing-plugin",
      name: "Failing Plugin",
      version: "1.0.0",
    },
    init(ctx: ClientPluginContext) {
      ctx.registerLaunchHook({
        stage: "pre-launch:validate",
        execute: () => {
          stagesExecuted.push("validate");
        },
      });
      ctx.registerLaunchHook({
        stage: "pre-launch:stage",
        execute: () => {
          stagesExecuted.push("stage");
          throw new Error("Anti-cheat integrity check failed");
        },
      });
      ctx.registerLaunchHook({
        stage: "post-exit:cleanup",
        execute: () => {
          stagesExecuted.push("cleanup-never");
        },
      });
    },
  };

  await manager.registerPlugin(
    failingPlugin,
    "failing-plugin",
    [],
    ["game:launch-hook"],
  );

  const context = {
    gameId: "game-42",
    gameTitle: "Test Adventure",
    gameDir: "/tmp/test-game",
  };

  let launchRan = false;
  await assert.rejects(
    () =>
      manager.executeLaunchPipeline(context, async () => {
        launchRan = true;
      }),
    /Launch aborted during stage 'pre-launch:stage': Anti-cheat integrity check failed/,
  );

  assert.equal(launchRan, false);
  assert.deepEqual(stagesExecuted, ["validate", "stage"]);
});

test("ClientPluginManager aggregates PlayActions and tolerates failing providers", async () => {
  const manager = new ClientPluginManager();

  const providerPlugin1: ClientPlugin = {
    metadata: { id: "p1", name: "P1", version: "1.0.0" },
    init(ctx: ClientPluginContext) {
      ctx.registerPlayAction(() => [
        {
          id: "action-offline",
          name: "Play Offline",
          execute: () => {},
        },
      ]);
    },
  };

  const providerPlugin2: ClientPlugin = {
    metadata: { id: "p2", name: "P2", version: "1.0.0" },
    init(ctx: ClientPluginContext) {
      ctx.registerPlayAction(() => {
        throw new Error("Provider error");
      });
      ctx.registerPlayAction(() => [
        {
          id: "action-multiplayer",
          name: "Play Multiplayer Room",
          execute: () => {},
        },
      ]);
    },
  };

  await manager.registerPlugin(providerPlugin1, "p1", [], ["ui:play-action"]);
  await manager.registerPlugin(providerPlugin2, "p2", [], ["ui:play-action"]);

  const actions = await manager.getPlayActions("game-123");
  assert.equal(actions.length, 2);
  assert.equal(actions[0]?.id, "action-offline");
  assert.equal(actions[1]?.id, "action-multiplayer");
});
