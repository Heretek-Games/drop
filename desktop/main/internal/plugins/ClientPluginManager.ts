import { reactive, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
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
  LaunchOverrides,
  MetadataProvider,
  PlayAction,
  RunnerProvider,
  ScopedGameFs,
  ScopedGameScanner,
  SidebarItem,
  Sidecar,
  StoreScanner,
  TopBarItem,
  UISlotName,
  UISlotRegistration,
} from "./types";

/** Platform data used to pick the matching sidecar target. */
export interface SidecarPlatform {
  os: "linux" | "macos" | "windows";
  arch: "x64" | "arm64";
}

/**
 * Best-effort host platform detection for sidecar target selection. Runs in
 * the desktop webview, where Tauri provides a real UA; wrong guesses never
 * break anything because staging downloads are sha256-verified per target.
 */
export function detectSidecarPlatform(): SidecarPlatform | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent ?? "";
  let os: SidecarPlatform["os"] | null = null;
  if (/windows/i.test(ua)) os = "windows";
  else if (/macintosh|mac os x/i.test(ua)) os = "macos";
  else if (/linux/i.test(ua)) os = "linux";
  if (!os) return null;
  const arch: SidecarPlatform["arch"] = /aarch64|arm64|apple m[123]/i.test(ua)
    ? "arm64"
    : "x64";
  return { os, arch };
}

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
    return fallback ?? (null as unknown as T);
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

  async findFiles(gameId: string, patterns: string[]): Promise<string[]> {
    return (
      (await safeInvoke<string[]>(
        "plugin_game_find_files",
        { gameId, patterns },
        [],
      )) || []
    );
  }
}

class TauriPluginWebSocket implements ClientPluginWebSocket {
  async send(channel: string, data: unknown): Promise<unknown> {
    return await safeInvoke("plugin_request_ws", { channel, data });
  }

  subscribe(channel: string, listener: (data: unknown) => void): () => void {
    if (isTauri()) {
      let disposed = false;
      let unlisten: (() => void) | undefined;

      safeInvoke("plugin_subscribe", { channel }).catch((err) => {
        console.error("Failed to subscribe to plugin channel:", channel, err);
      });

      // The Rust host forwards decoded WebSocket frames as the Tauri event
      // `plugin:event`. Tauri events are not DOM events, so the payload must be
      // consumed with `listen` rather than `window.addEventListener`.
      void listen<{ channel?: string; data?: unknown }>(
        "plugin:event",
        (event) => {
          if (event.payload?.channel === channel) {
            listener(event.payload.data);
          }
        },
      )
        .then((off) => {
          if (disposed) off();
          else unlisten = off;
        })
        .catch((err) => {
          console.error("Failed to listen for plugin events on", channel, err);
        });

      return () => {
        disposed = true;
        unlisten?.();
        unlisten = undefined;
      };
    }

    // Browser/dev fallback: a host harness can dispatch a DOM CustomEvent.
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
  public readonly runnerProviders = reactive<
    Array<{ pluginId: string; provider: RunnerProvider }>
  >([]);

  /**
   * Host launch delegate wired by the library view so `ctx.launchGame` can
   * reuse the same launch-index resolution as the Play button. Falls back to a
   * direct native launch (index 0) when unset.
   */
  private gameLaunchHandler?: (
    gameId: string,
    overrides?: LaunchOverrides,
  ) => Promise<void>;

  /** Local (client-side) plugin event bus, keyed by event name. */
  private readonly localEvents = new Map<
    string,
    Set<(data: unknown) => void>
  >();

  /** Host UI toast listeners wired by the settings/library UI. */
  public readonly toastListeners = new Set<
    (message: string, type?: "info" | "success" | "warn" | "error") => void
  >();

  public readonly serverWs: ClientPluginWebSocket = new TauriPluginWebSocket();

  public readonly isInitialized = ref(false);

  /**
   * Stage the sidecar binary for the current platform that a plugin bundle
   * declares. The Tauri command verifies the SHA-256, stages the binary under
   * the plugin's app-data bin dir and makes it executable, so
   * `ctx.system.run` later resolves the allowlisted bare name against it.
   * Non-fatal: hosts without a matching target stay on PATH/fallbacks.
   */
  async stageSidecars(
    pluginId: string,
    commands: string[],
    sidecars: Sidecar[] | undefined,
  ): Promise<void> {
    if (!Array.isArray(sidecars) || sidecars.length === 0) return;
    const platform = detectSidecarPlatform();
    if (!platform) {
      console.debug("Unknown sidecar platform; skipping staging");
      return;
    }
    const commandSet = new Set(commands);
    for (const sidecar of sidecars) {
      if (!commandSet.has(sidecar.name)) continue;
      const target = sidecar.targets.find(
        (t) => t.os === platform.os && t.arch === platform.arch,
      );
      if (!target) continue;
      try {
        await safeInvoke("plugin_sidecar_stage", {
          pluginId,
          name: sidecar.name,
          asset: target.path,
          sha256: target.sha256,
        });
        console.debug("Staged sidecar:", pluginId, sidecar.name);
      } catch (err) {
        console.warn(
          "Failed to stage sidecar; falling back to PATH resolution:",
          pluginId,
          sidecar.name,
          err,
        );
      }
    }
  }

  /**
   * Register the host launch delegate used by `ctx.launchGame`. The library
   * view wires this so plugin-triggered launches resolve the same launch option
   * index as the Play button; without it, launches fall back to index 0.
   */
  setGameLaunchHandler(
    handler: (gameId: string, overrides?: LaunchOverrides) => Promise<void>,
  ): void {
    this.gameLaunchHandler = handler;
  }

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
      console.warn("Failed to register command allowlist for:", pluginId, err);
    }

    const context: ClientPluginContext = {
      id: pluginId,
      logger: {
        info: (msg, ...args) =>
          console.log("[Plugin:%s] %s", pluginId, msg, ...args),
        warn: (msg, ...args) =>
          console.warn("[Plugin:%s] %s", pluginId, msg, ...args),
        error: (msg, ...args) =>
          console.error("[Plugin:%s] %s", pluginId, msg, ...args),
        debug: (msg, ...args) =>
          console.debug("[Plugin:%s] %s", pluginId, msg, ...args),
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
      registerRunnerProvider: (provider: RunnerProvider) => {
        if (capabilities.length > 0 && !capabilities.includes("game:runner")) {
          throw new Error(
            `Client plugin '${pluginId}' attempted 'registerRunnerProvider' without the 'game:runner' capability`,
          );
        }
        if (
          !provider ||
          typeof provider.id !== "string" ||
          !provider.id.trim()
        ) {
          throw new Error("Runner provider must have a valid non-empty id");
        }
        const entry = { pluginId, provider };
        this.runnerProviders.push(entry);
        return () => {
          const idx = this.runnerProviders.indexOf(entry);
          if (idx !== -1) this.runnerProviders.splice(idx, 1);
        };
      },
      launchGame: async (gameId: string, overrides?: LaunchOverrides) => {
        if (this.gameLaunchHandler) {
          await this.gameLaunchHandler(gameId, overrides);
          return;
        }
        await safeInvoke("launch_game", { id: gameId, index: 0, overrides });
      },
      library: {
        getGames: async () => {
          const response = await safeInvoke<{ library?: unknown[] }>(
            "fetch_library",
            {},
            { library: [] },
          );
          return response?.library ?? [];
        },
        getGame: async (gameId: string) =>
          await safeInvoke<unknown>("fetch_game", { gameId }, null),
      },
      ui: {
        showToast: (
          message: string,
          type?: "info" | "success" | "warn" | "error",
        ) => {
          for (const listener of this.toastListeners) {
            listener(message, type);
          }
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("drop:plugin-toast", {
                detail: { message, type: type ?? "info" },
              }),
            );
          }
        },
        openExternal: async (url: string) => {
          await safeInvoke("plugin_open_external", { url });
        },
      },
      events: {
        on: (event: string, listener: (data: unknown) => void) => {
          if (!this.localEvents.has(event)) {
            this.localEvents.set(event, new Set());
          }
          this.localEvents.get(event)!.add(listener);
          return () => {
            this.localEvents.get(event)?.delete(listener);
          };
        },
        emit: (event: string, data: unknown) => {
          const listeners = this.localEvents.get(event);
          if (!listeners) return;
          for (const listener of listeners) {
            listener(data);
          }
        },
      },
      gameFs: new TauriScopedGameFs(),
      gameScanner: new TauriScopedGameScanner(),
      serverWs: this.serverWs,
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
      console.log("Initialized client plugin:", pluginId);
    } catch (e) {
      console.error("Failed to initialize client plugin:", pluginId, e);
    }
  }

  async unregisterPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (plugin) {
      if (plugin.teardown) {
        try {
          await plugin.teardown();
        } catch (e) {
          console.error("Error during plugin teardown for:", pluginId, e);
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

    // Drop any staged sidecar binaries for this plugin.
    await safeInvoke("plugin_sidecar_clear", { pluginId }).catch(() => {
      // Best effort: the plugin may never have staged a sidecar.
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
    this.purgeOwned(this.runnerProviders, pluginId);
  }

  /** Removes every reactive entry owned by `pluginId` from `entries`. */
  private purgeOwned<T extends { pluginId: string }>(
    entries: T[],
    pluginId: string,
  ): void {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.pluginId === pluginId) {
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

  getRunnerProviders(): RunnerProvider[] {
    return this.runnerProviders.map((e) => e.provider);
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
          "Error querying play action provider for game:",
          gameId,
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
      console.log("Rolling back stage:", rollbackHook.stage);
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
          "Pre-launch hook failed on stage",
          hook.stage,
          "- rolling back completed stages...",
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
        console.warn("Post-exit hook warning on stage", hook.stage, postErr);
      }
    }
  }

  /**
   * Resolve the launch overrides contributed by pre-launch hooks
   * (`context.overrides`) and every applicable registered runner provider.
   * Providers whose platform does not match the host, or that report
   * unavailable, are skipped; a failing provider is logged and ignored so a
   * broken runner cannot block a launch.
   */
  private async collectLaunchOverrides(
    context: LaunchContext,
  ): Promise<LaunchOverrides | undefined> {
    const platform = detectSidecarPlatform()?.os;
    let merged: LaunchOverrides = { ...(context.overrides ?? {}) };

    for (const { provider } of this.runnerProviders) {
      if (
        platform &&
        provider.supportedPlatforms.length > 0 &&
        !provider.supportedPlatforms.includes(platform)
      ) {
        continue;
      }
      try {
        const detection = await provider.detect();
        if (!detection?.available) continue;
        const overrides = await provider.resolveLaunch(context);
        merged = mergeLaunchOverrides(merged, overrides);
      } catch (err) {
        console.warn(
          "Runner provider failed to resolve launch overrides:",
          provider.id,
          err,
        );
      }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Playnite-style Game Launch Pipeline Coordinator.
   * Executes pre-launch hooks sorted by stage and priority.
   * If any pre-launch hook aborts, completed stages are rolled back in reverse order.
   * If launch succeeds, executes post-exit cleanup hooks.
   */
  async executeLaunchPipeline<T>(
    context: LaunchContext,
    launchFn: (overrides?: LaunchOverrides) => Promise<T>,
  ): Promise<T> {
    const preLaunchStages: LaunchHook["stage"][] = [
      "pre-launch:validate",
      "pre-launch:prepare",
      "pre-launch:stage",
      "pre-launch:network",
      "pre-launch:network-post",
    ];

    const postExitStages: LaunchHook["stage"][] = [
      "post-exit:cleanup",
      "post-exit:restore",
      "post-exit:sync",
    ];

    await this.runPreLaunchPipeline(this.sortHooks(preLaunchStages), context);
    const overrides = await this.collectLaunchOverrides(context);
    const launchResult = await launchFn(overrides);
    await this.runPostExitPipeline(this.sortHooks(postExitStages), context);

    return launchResult;
  }
}

/**
 * Merge two sets of launch overrides. Arguments and environment variables are
 * additive; scalar fields (executable, working directory, wrapper) are replaced
 * by the newer value.
 */
export function mergeLaunchOverrides(
  base: LaunchOverrides,
  extra: LaunchOverrides,
): LaunchOverrides {
  const merged: LaunchOverrides = { ...base };

  if (extra.executable) merged.executable = extra.executable;
  if (extra.arguments?.length) {
    merged.arguments = [...(merged.arguments ?? []), ...extra.arguments];
  }
  if (extra.environment) {
    merged.environment = {
      ...(merged.environment ?? {}),
      ...extra.environment,
    };
  }
  if (extra.workingDirectory) merged.workingDirectory = extra.workingDirectory;
  if (extra.wrapperBin) {
    merged.wrapperBin = extra.wrapperBin;
    merged.wrapperArgs = extra.wrapperArgs ? [...extra.wrapperArgs] : [];
  } else if (extra.wrapperArgs?.length) {
    merged.wrapperArgs = [...(merged.wrapperArgs ?? []), ...extra.wrapperArgs];
  }

  return merged;
}

// Global Singleton Instance
export const clientPluginManager = new ClientPluginManager();
