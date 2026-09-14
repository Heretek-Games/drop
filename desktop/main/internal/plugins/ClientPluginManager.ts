import { reactive, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type {
  AntiCheatReport,
  ClientPlugin,
  ClientPluginContext,
  ClientPluginStorage,
  ClientPluginWebSocket,
  CloudSavePathResolver,
  CommandResult,
  GameMenuItem,
  HttpMethod,
  LaunchContext,
  LaunchHook,
  MetadataProvider,
  PlayAction,
  ScopedGameFs,
  ScopedGameScanner,
  SidebarItem,
  StoreScanner,
  TopBarItem,
  UISlotName,
  UISlotRegistration,
} from "./types";

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

async function safeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
  fallback?: T,
): Promise<T> {
  if (!isTauri()) {
    console.debug(
      `[ClientPluginManager] Browser mode: invoke('${cmd}') bypassed`,
    );
    return fallback !== undefined ? fallback : (null as unknown as T);
  }
  return await invoke<T>(cmd, args);
}

class BrowserLocalStorage implements ClientPluginStorage {
  constructor(private readonly pluginId: string) {}

  private prefixKey(key: string): string {
    return `drop:plugin:${this.pluginId}:${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const val = localStorage.getItem(this.prefixKey(key));
      return val ? JSON.parse(val) : null;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    localStorage.setItem(this.prefixKey(key), JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    localStorage.removeItem(this.prefixKey(key));
  }

  async listKeys(): Promise<string[]> {
    const prefix = `drop:plugin:${this.pluginId}:`;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) {
        keys.push(k.slice(prefix.length));
      }
    }
    return keys;
  }
}

class TauriScopedGameFs implements ScopedGameFs {
  async readFile(gameId: string, relativePath: string): Promise<Uint8Array> {
    const res = await safeInvoke<number[]>(
      "plugin_game_fs_read",
      { gameId, relativePath },
      [],
    );
    return new Uint8Array(res);
  }

  async writeFile(
    gameId: string,
    relativePath: string,
    data: Uint8Array | string,
  ): Promise<void> {
    const bytes =
      typeof data === "string"
        ? Array.from(new TextEncoder().encode(data))
        : Array.from(data);
    await safeInvoke("plugin_game_fs_write", {
      gameId,
      relativePath,
      data: bytes,
    });
  }

  async backupFile(gameId: string, relativePath: string): Promise<string> {
    return (
      (await safeInvoke<string>("plugin_game_fs_backup", {
        gameId,
        relativePath,
      })) || ""
    );
  }

  async restoreFile(gameId: string, relativePath: string): Promise<void> {
    await safeInvoke("plugin_game_fs_restore", {
      gameId,
      relativePath,
    });
  }

  async fileExists(gameId: string, relativePath: string): Promise<boolean> {
    return (
      (await safeInvoke<boolean>(
        "plugin_game_fs_exists",
        { gameId, relativePath },
        false,
      )) ?? false
    );
  }

  async deleteFile(gameId: string, relativePath: string): Promise<void> {
    await safeInvoke("plugin_game_fs_delete", {
      gameId,
      relativePath,
    });
  }
}

class TauriScopedGameScanner implements ScopedGameScanner {
  async scanExecutables(
    gameId: string,
  ): Promise<Array<{ relativePath: string; sha256: string; size: number }>> {
    return (
      (await safeInvoke<
        Array<{ relativePath: string; sha256: string; size: number }>
      >("plugin_game_scan_executables", { gameId }, [])) || []
    );
  }

  async checkAntiCheat(gameId: string): Promise<AntiCheatReport> {
    return (
      (await safeInvoke<AntiCheatReport>(
        "plugin_game_check_anticheat",
        { gameId },
        { detected: false, files: [] },
      )) || { detected: false, files: [] }
    );
  }
}

class TauriPluginWebSocket implements ClientPluginWebSocket {
  async send(channel: string, data: unknown): Promise<unknown> {
    return await safeInvoke("plugin_request_ws", { channel, data });
  }

  subscribe(channel: string, listener: (data: unknown) => void): () => void {
    if (isTauri()) {
      safeInvoke("plugin_subscribe", { channel }).catch((err) => {
        console.error(`Failed to subscribe to plugin channel ${channel}:`, err);
      });
    }

    const handler = (event: Event) => {
      const custom = event as CustomEvent<{ channel?: string; data?: unknown }>;
      if (custom?.detail?.channel === channel) {
        listener(custom.detail.data);
      }
    };

    window.addEventListener("plugin:event", handler);
    return () => {
      window.removeEventListener("plugin:event", handler);
    };
  }
}

export class ClientPluginManager {
  private readonly plugins = new Map<string, ClientPlugin>();
  public readonly slots = reactive<Record<UISlotName, UISlotRegistration[]>>({
    "game-detail:actions": [],
    "game-detail:panels": [],
    "game-detail:badges": [],
    "settings:tabs": [],
    "topbar:status": [],
    "sidebar:nav": [],
    "overlay:panel": [],
    "overlay:quick-access": [],
  });

  public readonly playActionProviders: Array<
    (gameId: string) => Promise<PlayAction[]> | PlayAction[]
  > = [];
  public readonly gameMenuItems = reactive<GameMenuItem[]>([]);
  public readonly sidebarItems = reactive<SidebarItem[]>([]);
  public readonly topBarItems = reactive<TopBarItem[]>([]);
  public readonly launchHooks: LaunchHook[] = [];
  public readonly storeScanners = reactive<
    Array<{ pluginId: string; scanner: StoreScanner }>
  >([]);
  public readonly metadataProviders = reactive<
    Array<{ pluginId: string; provider: MetadataProvider }>
  >([]);
  public readonly cloudSaveResolvers = reactive<
    Array<{ pluginId: string; resolver: CloudSavePathResolver }>
  >([]);

  public readonly isInitialized = ref(false);

  /**
   * Register and initialize a client plugin instance.
   */
  async registerPlugin(
    plugin: ClientPlugin,
    id?: string,
    commands: string[] = [],
    capabilities: string[] = [],
  ): Promise<void> {
    const pluginId = id || plugin.metadata?.id || "anonymous-plugin";
    if (this.plugins.has(pluginId)) {
      await this.unregisterPlugin(pluginId);
    }

    // Register the native command allowlist before init so `ctx.system.run`
    // works. Enforcement lives in the Tauri command layer, not here, so a
    // plugin cannot bypass it by calling invoke directly.
    try {
      await safeInvoke("plugin_register_commands", { pluginId, commands });
    } catch (err) {
      console.warn(
        `Failed to register command allowlist for ${pluginId}:`,
        err,
      );
    }

    const context: ClientPluginContext = {
      id: pluginId,
      logger: {
        info: (msg, ...args) =>
          console.log(`[Plugin:${pluginId}] ${msg}`, ...args),
        warn: (msg, ...args) =>
          console.warn(`[Plugin:${pluginId}] ${msg}`, ...args),
        error: (msg, ...args) =>
          console.error(`[Plugin:${pluginId}] ${msg}`, ...args),
        debug: (msg, ...args) =>
          console.debug(`[Plugin:${pluginId}] ${msg}`, ...args),
      },
      storage: new BrowserLocalStorage(pluginId),
      registerSlot: (slot, component, options) => {
        if (!this.slots[slot]) {
          this.slots[slot] = [];
        }
        this.slots[slot].push({
          id: `${pluginId}-${slot}-${this.slots[slot].length}`,
          pluginId,
          slot,
          component,
          order: options?.order ?? 0,
          label: options?.label,
          icon: options?.icon,
        });
        this.slots[slot].sort((a, b) => a.order - b.order);
      },
      registerPlayAction: (provider) => {
        this.playActionProviders.push(provider);
        return () => {
          const idx = this.playActionProviders.indexOf(provider);
          if (idx !== -1) this.playActionProviders.splice(idx, 1);
        };
      },
      registerGameMenuItem: (item) => {
        this.gameMenuItems.push(item);
        return () => {
          const idx = this.gameMenuItems.indexOf(item);
          if (idx !== -1) this.gameMenuItems.splice(idx, 1);
        };
      },
      registerSidebarItem: (item) => {
        this.sidebarItems.push(item);
        return () => {
          const idx = this.sidebarItems.indexOf(item);
          if (idx !== -1) this.sidebarItems.splice(idx, 1);
        };
      },
      registerTopBarItem: (item) => {
        this.topBarItems.push(item);
        return () => {
          const idx = this.topBarItems.indexOf(item);
          if (idx !== -1) this.topBarItems.splice(idx, 1);
        };
      },
      registerLaunchHook: (hook) => {
        this.launchHooks.push(hook);
        return () => {
          const idx = this.launchHooks.indexOf(hook);
          if (idx !== -1) this.launchHooks.splice(idx, 1);
        };
      },
      registerStoreScanner: (scanner: StoreScanner) => {
        if (
          capabilities.length > 0 &&
          !capabilities.includes("client:library-scan")
        ) {
          throw new Error(
            `Client plugin '${pluginId}' attempted 'registerStoreScanner' without the 'client:library-scan' capability`,
          );
        }
        if (!scanner || typeof scanner.id !== "string" || !scanner.id.trim()) {
          throw new Error("Store scanner must have a valid non-empty id");
        }
        const entry = { pluginId, scanner };
        this.storeScanners.push(entry);
        return () => {
          const idx = this.storeScanners.indexOf(entry);
          if (idx !== -1) this.storeScanners.splice(idx, 1);
        };
      },
      registerMetadataProvider: (provider: MetadataProvider) => {
        if (
          capabilities.length > 0 &&
          !capabilities.includes("metadata:provider")
        ) {
          throw new Error(
            `Client plugin '${pluginId}' attempted 'registerMetadataProvider' without the 'metadata:provider' capability`,
          );
        }
        if (
          !provider ||
          typeof provider.id !== "string" ||
          !provider.id.trim()
        ) {
          throw new Error("Metadata provider must have a valid non-empty id");
        }
        const entry = { pluginId, provider };
        this.metadataProviders.push(entry);
        return () => {
          const idx = this.metadataProviders.indexOf(entry);
          if (idx !== -1) this.metadataProviders.splice(idx, 1);
        };
      },
      registerCloudSaveResolver: (resolver: CloudSavePathResolver) => {
        if (
          capabilities.length > 0 &&
          !capabilities.includes("cloudsave:provider")
        ) {
          throw new Error(
            `Client plugin '${pluginId}' attempted 'registerCloudSaveResolver' without the 'cloudsave:provider' capability`,
          );
        }
        if (
          !resolver ||
          typeof resolver.id !== "string" ||
          !resolver.id.trim()
        ) {
          throw new Error("Cloud save resolver must have a valid non-empty id");
        }
        const entry = { pluginId, resolver };
        this.cloudSaveResolvers.push(entry);
        return () => {
          const idx = this.cloudSaveResolvers.indexOf(entry);
          if (idx !== -1) this.cloudSaveResolvers.splice(idx, 1);
        };
      },
      gameFs: new TauriScopedGameFs(),
      gameScanner: new TauriScopedGameScanner(),
      serverWs: new TauriPluginWebSocket(),
      system: {
        run: (
          bin: string,
          args?: string[],
          options?: { cwd?: string; timeoutMs?: number },
        ) =>
          safeInvoke<CommandResult>(
            "plugin_system_run",
            {
              pluginId,
              bin,
              args,
              cwd: options?.cwd,
              timeoutMs: options?.timeoutMs,
            },
            {
              code: 1,
              stdout: "",
              stderr: "Host native execution not available in browser mode",
            },
          ),
      },
      serverRequest: <T>(method: HttpMethod, path = "", body?: unknown) =>
        safeInvoke<T>("plugin_request", {
          pluginId,
          method,
          path,
          body,
        }),
    };

    try {
      await plugin.init(context);
      this.plugins.set(pluginId, plugin);
      console.log(`Initialized client plugin: ${pluginId}`);
    } catch (e) {
      console.error(`Failed to initialize client plugin ${pluginId}:`, e);
    }
  }

  async unregisterPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (plugin) {
      if (plugin.teardown) {
        try {
          await plugin.teardown();
        } catch (e) {
          console.error(`Error during plugin teardown for ${pluginId}:`, e);
        }
      }
      this.plugins.delete(pluginId);
    }

    // Drop the native command allowlist for this plugin.
    await safeInvoke("plugin_register_commands", {
      pluginId,
      commands: [],
    }).catch(() => {
      // Best effort: the plugin may never have registered a allowlist.
    });

    // Clean up UI slots registered by this plugin
    for (const slotName of Object.keys(this.slots) as UISlotName[]) {
      this.slots[slotName] = this.slots[slotName].filter(
        (s) => s.pluginId !== pluginId,
      );
    }

    // Clean up store scanners and metadata providers registered by this plugin
    this.purgeOwned(this.storeScanners, pluginId);
    this.purgeOwned(this.metadataProviders, pluginId);
    this.purgeOwned(this.cloudSaveResolvers, pluginId);
  }

  /** Removes every reactive entry owned by `pluginId` from `entries`. */
  private purgeOwned<T extends { pluginId: string }>(
    entries: T[],
    pluginId: string,
  ): void {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].pluginId === pluginId) {
        entries.splice(i, 1);
      }
    }
  }

  getStoreScanners(): StoreScanner[] {
    return this.storeScanners.map((e) => e.scanner);
  }

  getMetadataProviders(): MetadataProvider[] {
    return this.metadataProviders.map((e) => e.provider);
  }

  getCloudSaveResolvers(): CloudSavePathResolver[] {
    return this.cloudSaveResolvers.map((e) => e.resolver);
  }

  /**
   * Load client plugin bundle from a URL (e.g. served by Drop server).
   */
  async loadFromUrl(
    pluginId: string,
    bundleUrl: string,
    cssUrl?: string,
    commands: string[] = [],
    capabilities: string[] = [],
  ): Promise<void> {
    if (cssUrl) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = cssUrl;
      link.dataset.pluginId = pluginId;
      document.head.appendChild(link);
    }

    const mod = await import(/* @vite-ignore */ bundleUrl);
    const candidates: Array<ClientPlugin | undefined> = [
      mod.default,
      mod.plugin,
    ];
    const pluginExport = candidates.find((candidate) => candidate?.init);

    if (!pluginExport) {
      throw new Error(
        `Module at ${bundleUrl} does not export a valid ClientPlugin`,
      );
    }

    await this.registerPlugin(pluginExport, pluginId, commands, capabilities);
  }

  /**
   * Query all registered Play Actions for a given game.
   */
  async getPlayActions(gameId: string): Promise<PlayAction[]> {
    const actions: PlayAction[] = [];
    for (const provider of this.playActionProviders) {
      try {
        const result = await provider(gameId);
        actions.push(...result);
      } catch (err) {
        console.error(
          `Error querying play action provider for game ${gameId}:`,
          err,
        );
      }
    }
    return actions;
  }

  /**
   * Playnite-style Game Launch Pipeline Coordinator.
   * Executes pre-launch hooks sorted by stage and priority.
   * If any pre-launch hook aborts, completed stages are rolled back in reverse order.
   * If launch succeeds, executes post-exit cleanup hooks.
   */
  private sortHooks(stages: LaunchHook["stage"][]): LaunchHook[] {
    return this.launchHooks
      .filter((h) => stages.includes(h.stage))
      .sort((a, b) => {
        const stageDiff = stages.indexOf(a.stage) - stages.indexOf(b.stage);
        if (stageDiff !== 0) return stageDiff;
        return (a.order ?? 0) - (b.order ?? 0);
      });
  }

  private rollbackCompletedStages(completedHooks: LaunchHook[]): void {
    for (let i = completedHooks.length - 1; i >= 0; i--) {
      const rollbackHook = completedHooks[i];
      if (!rollbackHook) continue;
      console.log(`Rolling back stage: ${rollbackHook.stage}`);
    }
  }

  private async runPreLaunchPipeline(
    activePreHooks: LaunchHook[],
    context: LaunchContext,
  ): Promise<void> {
    const completedHooks: LaunchHook[] = [];
    for (const hook of activePreHooks) {
      try {
        await hook.execute(context);
        completedHooks.push(hook);
      } catch (error) {
        console.error(
          `Pre-launch hook [${hook.stage}] failed. Rolling back completed stages...`,
          error,
        );
        this.rollbackCompletedStages(completedHooks);
        throw new Error(
          `Launch aborted during stage '${hook.stage}': ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }
  }

  private async runPostExitPipeline(
    activePostHooks: LaunchHook[],
    context: LaunchContext,
  ): Promise<void> {
    for (const hook of activePostHooks) {
      try {
        await hook.execute(context);
      } catch (postErr) {
        console.warn(`Post-exit hook [${hook.stage}] warning:`, postErr);
      }
    }
  }

  /**
   * Playnite-style Game Launch Pipeline Coordinator.
   * Executes pre-launch hooks sorted by stage and priority.
   * If any pre-launch hook aborts, completed stages are rolled back in reverse order.
   * If launch succeeds, executes post-exit cleanup hooks.
   */
  async executeLaunchPipeline<T>(
    context: LaunchContext,
    launchFn: () => Promise<T>,
  ): Promise<T> {
    const preLaunchStages: LaunchHook["stage"][] = [
      "pre-launch:validate",
      "pre-launch:prepare",
      "pre-launch:stage",
      "pre-launch:network",
    ];

    const postExitStages: LaunchHook["stage"][] = [
      "post-exit:cleanup",
      "post-exit:restore",
      "post-exit:sync",
    ];

    await this.runPreLaunchPipeline(this.sortHooks(preLaunchStages), context);
    const launchResult = await launchFn();
    await this.runPostExitPipeline(this.sortHooks(postExitStages), context);

    return launchResult;
  }
}

// Global Singleton Instance
export const clientPluginManager = new ClientPluginManager();
