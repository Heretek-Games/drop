import { createHash, createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { H3Event } from "h3";
import { getQuery, createError } from "h3";
import type { Logger } from "pino";
import { logger } from "../logging";
import { PLUGIN_API_VERSION } from "./types";
import {
  PluginApiVersionError,
  PluginCapabilityError,
  PluginTrustError,
} from "./errors";
import type {
  HttpMethod,
  PluginCapability,
  PluginContext,
  PluginManifest,
  PluginMetadata,
  PluginStateRecord,
  PluginStatus,
  PluginStorage,
  RouteHandler,
  RouteHandlerContext,
  ServerPlugin,
  WebSocketContext,
  WebSocketHandler,
} from "./types";

/** Resolved caller identity passed to route handlers. */
export interface PluginAuthContext {
  userId?: string | undefined;
  userAcls?: string[] | undefined;
}

/**
 * Injectable dependencies. The defaults resolve Drop's runtime config and ACL
 * manager lazily, so this module can be imported (and unit-tested) outside a
 * Nuxt/Nitro runtime.
 */
export interface PluginManagerOptions {
  /** Base data directory. Defaults to the server's configured data folder. */
  dataDir?: string;
  /** Per-plugin storage factory. Defaults to {@link FilePluginStorage}. */
  storageFactory?: (pluginId: string) => PluginStorage;
  /** Auth resolver for dispatched routes. Defaults to Drop's ACL manager. */
  authResolver?: (event: H3Event) => Promise<PluginAuthContext>;
}

interface RegisteredRoute {
  method: HttpMethod;
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

interface LoadedPlugin {
  plugin: ServerPlugin;
  context: PluginContext;
  status: PluginStatus;
  error?: Error;
}

export class PluginManager {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly routes = new Map<string, RegisteredRoute[]>();
  private readonly webSockets = new Map<
    string,
    { pluginId: string; handler: WebSocketHandler }
  >();
  private readonly eventBus = new EventEmitter();
  private readonly log: Logger = logger.child({ name: "plugin-manager" });

  constructor(private readonly options: PluginManagerOptions = {}) {
    this.eventBus.setMaxListeners(200);
  }

  private async getDataFolder(): Promise<string> {
    if (this.options.dataDir !== undefined) {
      return this.options.dataDir;
    }
    const { systemConfig } = await import("../config/sys-conf");
    return systemConfig.getDataFolder();
  }

  private async getStateFilePath(): Promise<string> {
    return path.join(await this.getDataFolder(), "plugins", "_state.json");
  }

  private async getPluginsDirectory(): Promise<string> {
    return path.join(await this.getDataFolder(), "plugins");
  }

  private async loadState(): Promise<Record<string, PluginStateRecord>> {
    try {
      const data = await fs.readFile(await this.getStateFilePath(), "utf-8");
      return JSON.parse(data) as Record<string, PluginStateRecord>;
    } catch {
      return {};
    }
  }

  private async saveState(
    state: Record<string, PluginStateRecord>,
  ): Promise<void> {
    const filePath = await this.getStateFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
  }

  private patternToRegex(pattern: string): {
    regex: RegExp;
    paramNames: string[];
  } {
    const paramNames: string[] = [];
    const normalized = pattern.startsWith("/") ? pattern : `/${pattern}`;

    const regexStr = normalized
      .replace(/\/+$/, "")
      .replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
        paramNames.push(name);
        return "([^/]+)";
      })
      .replace(/\*\*/g, "(.*)")
      .replace(/\*/g, "([^/]+)");

    return {
      regex: new RegExp(`^${regexStr || "/"}(?:/)?$`),
      paramNames,
    };
  }

  private hasCapability(
    capabilities: PluginCapability[] | undefined,
    cap: PluginCapability,
  ): boolean {
    if (!capabilities || capabilities.length === 0) return true;
    return capabilities.includes(cap);
  }

  private async createStorage(pluginId: string): Promise<PluginStorage> {
    if (this.options.storageFactory) {
      return this.options.storageFactory(pluginId);
    }
    const { FilePluginStorage } = await import("./storage");
    return new FilePluginStorage(pluginId);
  }

  /**
   * Restrict storage access to plugins that declared the `storage` capability.
   * Missing capability is fail-closed: every method throws rather than
   * silently reading/writing.
   */
  private guardStorage(
    pluginId: string,
    capabilities: PluginCapability[] | undefined,
    storage: PluginStorage,
  ): PluginStorage {
    if (this.hasCapability(capabilities, "storage")) {
      return storage;
    }
    const deny = (operation: string): never => {
      throw new PluginCapabilityError(pluginId, "storage", operation);
    };
    return {
      get: async () => deny("storage.get"),
      set: async () => deny("storage.set"),
      delete: async () => deny("storage.delete"),
      listKeys: async () => deny("storage.listKeys"),
      getSchemaVersion: async () => deny("storage.getSchemaVersion"),
      setSchemaVersion: async () => deny("storage.setSchemaVersion"),
    };
  }

  private async createPluginContext(
    plugin: ServerPlugin,
  ): Promise<PluginContext> {
    const id = plugin.metadata.id;
    const capabilities = plugin.metadata.capabilities;
    const pluginLogger = this.log.child({ plugin: id });
    const storage = this.guardStorage(
      id,
      capabilities,
      await this.createStorage(id),
    );
    const pluginRoutes: RegisteredRoute[] = [];
    this.routes.set(id, pluginRoutes);

    return {
      id,
      logger: pluginLogger,
      storage,
      registerRoute: (
        method: HttpMethod,
        pattern: string,
        handler: RouteHandler,
      ) => {
        if (!this.hasCapability(capabilities, "routes")) {
          throw new PluginCapabilityError(
            id,
            "routes",
            `registerRoute(${pattern})`,
          );
        }

        const { regex, paramNames } = this.patternToRegex(pattern);
        pluginRoutes.push({
          method,
          pattern,
          regex,
          paramNames,
          handler,
        });
        pluginLogger.debug(`Registered route [${method}] ${pattern}`);
      },
      broadcast: (channel: string, event: unknown) => {
        if (!this.hasCapability(capabilities, "events")) {
          throw new PluginCapabilityError(
            id,
            "events",
            `broadcast(${channel})`,
          );
        }
        this.eventBus.emit(channel, event);
      },
      subscribe: (channel: string, listener: (event: unknown) => void) => {
        if (!this.hasCapability(capabilities, "events")) {
          throw new PluginCapabilityError(
            id,
            "events",
            `subscribe(${channel})`,
          );
        }
        this.eventBus.on(channel, listener);
        return () => {
          this.eventBus.off(channel, listener);
        };
      },
      registerWebSocket: (channel: string, handler: WebSocketHandler) => {
        if (!this.hasCapability(capabilities, "websocket")) {
          throw new PluginCapabilityError(
            id,
            "websocket",
            `registerWebSocket(${channel})`,
          );
        }
        const existing = this.webSockets.get(channel);
        if (existing && existing.pluginId !== id) {
          throw new Error(
            `WebSocket channel '${channel}' is already claimed by plugin '${existing.pluginId}'`,
          );
        }
        this.webSockets.set(channel, { pluginId: id, handler });
      },
      fetch: async (input: string | URL, init?: RequestInit) => {
        if (!this.hasCapability(capabilities, "network")) {
          throw new PluginCapabilityError(id, "network", "fetch");
        }
        return fetch(input, init);
      },
    };
  }

  /**
   * Run a plugin's storage migrations when its recorded schema version is
   * behind the version it declares. No-op for plugins that do not set
   * `storageVersion`.
   */
  private async runStorageMigrations(
    plugin: ServerPlugin,
    storage: PluginStorage,
  ): Promise<void> {
    const target = plugin.metadata.storageVersion ?? 0;
    if (target <= 0) return;
    const current = await storage.getSchemaVersion();
    if (current >= target) return;
    if (plugin.migrateStorage) {
      await plugin.migrateStorage(current, target, storage);
    }
    await storage.setSchemaVersion(target);
  }

  /**
   * Verify an external bundle's entry file before importing it.
   *
   * - `checksum` (if present) must match the entry file's SHA-256.
   * - `signature` (if present) must be an HMAC-SHA256 of the checksum under
   *   `DROP_PLUGIN_SIGNING_KEY`.
   * - When `DROP_PLUGIN_REQUIRE_SIGNATURE=true`, an unsigned bundle is refused.
   */
  private async verifyBundleIntegrity(
    entryPath: string,
    manifest: PluginManifest,
  ): Promise<void> {
    const bytes = await fs.readFile(entryPath);
    const digest = createHash("sha256").update(bytes).digest("hex");

    if (manifest.checksum && manifest.checksum !== digest) {
      throw new Error(
        `bundle checksum mismatch for ${manifest.id}: expected ${manifest.checksum}, found ${digest}`,
      );
    }

    const signingKey = process.env.DROP_PLUGIN_SIGNING_KEY;
    if (manifest.signature) {
      if (!signingKey) {
        throw new Error(
          `bundle ${manifest.id} is signed but DROP_PLUGIN_SIGNING_KEY is not set`,
        );
      }
      const expected = createHmac("sha256", signingKey)
        .update(digest)
        .digest("hex");
      if (expected !== manifest.signature) {
        throw new Error(`bundle signature mismatch for ${manifest.id}`);
      }
    } else if (process.env.DROP_PLUGIN_REQUIRE_SIGNATURE === "true") {
      throw new Error(`bundle ${manifest.id} is unsigned`);
    }
  }

  private assertPluginCompatible(plugin: ServerPlugin): void {
    const { id, apiVersion, trust } = plugin.metadata;
    if (apiVersion !== undefined && apiVersion !== PLUGIN_API_VERSION) {
      throw new PluginApiVersionError(id, PLUGIN_API_VERSION, apiVersion);
    }
    if (trust !== undefined && trust !== "trusted") {
      throw new PluginTrustError(id, trust);
    }
  }

  async registerPlugin(plugin: ServerPlugin): Promise<void> {
    const id = plugin.metadata.id;
    this.assertPluginCompatible(plugin);
    if (this.plugins.has(id)) {
      this.log.warn(`Plugin ${id} is already registered, replacing`);
      await this.unregisterPlugin(id);
    }

    const state = await this.loadState();
    const isExplicitlyDisabled = state[id]?.enabled === false;

    const context = await this.createPluginContext(plugin);
    const loaded: LoadedPlugin = {
      plugin,
      context,
      status: isExplicitlyDisabled ? "disabled" : "registered",
    };
    this.plugins.set(id, loaded);

    if (isExplicitlyDisabled) {
      this.log.info(
        `Plugin '${plugin.metadata.name}' (${id}) is registered but disabled by configuration`,
      );
      return;
    }

    await this.runStorageMigrations(plugin, context.storage);

    try {
      await plugin.init(context);
      loaded.status = "active";
      this.log.info(
        `Plugin '${plugin.metadata.name}' (${id} v${plugin.metadata.version}) initialized`,
      );
    } catch (err) {
      loaded.status = "error";
      loaded.error = err as Error;
      this.log.error(`Failed to initialize plugin ${id}: ${err}`);
      throw err;
    }
  }

  async unregisterPlugin(id: string): Promise<void> {
    const loaded = this.plugins.get(id);
    if (!loaded) return;

    if (loaded.plugin.teardown && loaded.status === "active") {
      try {
        await loaded.plugin.teardown();
      } catch (err) {
        this.log.warn(`Error during plugin ${id} teardown: ${err}`);
      }
    }

    this.plugins.delete(id);
    this.routes.delete(id);
    for (const [channel, entry] of this.webSockets) {
      if (entry.pluginId === id) {
        this.webSockets.delete(channel);
      }
    }
    this.log.info(`Plugin ${id} unregistered`);
  }

  async togglePlugin(id: string, enabled: boolean): Promise<boolean> {
    const loaded = this.plugins.get(id);
    if (!loaded) {
      throw createError({
        statusCode: 404,
        statusMessage: `Plugin '${id}' not found`,
      });
    }

    const state = await this.loadState();
    state[id] = { enabled, updatedAt: Date.now() };
    await this.saveState(state);

    if (!enabled) {
      if (loaded.status === "active") {
        if (loaded.plugin.teardown) {
          try {
            await loaded.plugin.teardown();
          } catch (err) {
            this.log.warn(`Error tearing down plugin ${id}: ${err}`);
          }
        }
        this.routes.delete(id);
        loaded.status = "disabled";
        this.log.info(`Plugin '${id}' disabled`);
        this.broadcast("plugins:state", { id, enabled: false });
      }
    } else {
      if (loaded.status !== "active") {
        const context = await this.createPluginContext(loaded.plugin);
        loaded.context = context;
        await this.runStorageMigrations(loaded.plugin, context.storage);
        try {
          await loaded.plugin.init(context);
          loaded.status = "active";
          loaded.error = undefined;
          this.log.info(`Plugin '${id}' enabled and initialized`);
          this.broadcast("plugins:state", { id, enabled: true });
        } catch (err) {
          loaded.status = "error";
          loaded.error = err as Error;
          this.log.error(`Failed to re-initialize plugin ${id}: ${err}`);
          throw err;
        }
      }
    }

    return true;
  }

  async discoverAndLoadExternalPlugins(): Promise<void> {
    const pluginsDir = await this.getPluginsDirectory();
    try {
      await fs.mkdir(pluginsDir, { recursive: true });
      const entries = await fs.readdir(pluginsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

        const pluginDir = path.join(pluginsDir, entry.name);
        let manifestContent: string | null = null;
        let manifestFile = path.join(pluginDir, "drop-plugin.json");

        try {
          manifestContent = await fs.readFile(manifestFile, "utf-8");
        } catch {
          try {
            manifestFile = path.join(pluginDir, "plugin.json");
            manifestContent = await fs.readFile(manifestFile, "utf-8");
          } catch {
            continue;
          }
        }

        if (!manifestContent) continue;

        try {
          const manifest: PluginManifest = JSON.parse(manifestContent);
          if (!manifest.id || !manifest.name || !manifest.version) {
            this.log.warn(`Invalid plugin manifest in ${pluginDir}`);
            continue;
          }

          if (this.plugins.has(manifest.id)) {
            continue;
          }

          const entryRel = manifest.entry || "index.js";
          const entryPath = path.resolve(pluginDir, entryRel);

          await this.verifyBundleIntegrity(entryPath, manifest);

          const mod = await import(pathToFileURL(entryPath).href);
          const pluginInstance: ServerPlugin =
            mod.default && typeof mod.default.init === "function"
              ? mod.default
              : mod.plugin && typeof mod.plugin.init === "function"
                ? mod.plugin
                : typeof mod.default === "function"
                  ? new mod.default()
                  : null;

          if (!pluginInstance) {
            this.log.error(
              `Plugin module at ${entryPath} does not export a valid ServerPlugin`,
            );
            continue;
          }

          pluginInstance.metadata = {
            ...manifest,
            builtin: false,
          };

          await this.registerPlugin(pluginInstance);
        } catch (err) {
          this.log.error(
            `Failed to load external plugin from ${pluginDir}: ${err}`,
          );
        }
      }
    } catch (err) {
      this.log.debug(`External plugins directory check: ${err}`);
    }
  }

  async reloadPlugins(): Promise<void> {
    this.log.info("Reloading external plugins...");
    for (const [id, loaded] of this.plugins.entries()) {
      if (!loaded.plugin.metadata.builtin) {
        await this.unregisterPlugin(id);
      }
    }
    await this.discoverAndLoadExternalPlugins();
  }

  listPlugins(): Array<
    PluginMetadata & {
      status: PluginStatus;
      error?: string;
    }
  > {
    return Array.from(this.plugins.values()).map((p) => ({
      ...p.plugin.metadata,
      status: p.status,
      error: p.error?.message,
    }));
  }

  getPlugin(id: string): ServerPlugin | undefined {
    return this.plugins.get(id)?.plugin;
  }

  broadcast(channel: string, data: unknown): void {
    this.eventBus.emit(channel, data);
  }

  subscribe(channel: string, listener: (data: unknown) => void): () => void {
    this.eventBus.on(channel, listener);
    return () => {
      this.eventBus.off(channel, listener);
    };
  }

  /** Route a client WebSocket message to the plugin that claimed the channel. */
  async dispatchWebSocket(
    channel: string,
    message: unknown,
    context: WebSocketContext,
  ): Promise<boolean> {
    const entry = this.webSockets.get(channel);
    if (!entry) return false;
    await entry.handler(message, context);
    return true;
  }

  webSocketChannels(): string[] {
    return Array.from(this.webSockets.keys());
  }

  private async resolveAuth(event: H3Event): Promise<PluginAuthContext> {
    if (this.options.authResolver) {
      return this.options.authResolver(event);
    }
    const { default: aclManager } = await import("../acls");
    const userId = (await aclManager.getUserIdACL(event, [])) ?? undefined;
    const allAcls = await aclManager.fetchAllACLs(event);
    return { userId, userAcls: allAcls ? Array.from(allAcls) : undefined };
  }

  async dispatch(
    pluginId: string,
    method: string,
    rawSubPath: string,
    event: H3Event,
  ): Promise<unknown> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) {
      throw createError({
        statusCode: 404,
        statusMessage: `Plugin '${pluginId}' not found`,
      });
    }

    if (loaded.status !== "active") {
      throw createError({
        statusCode: 503,
        statusMessage: `Plugin '${pluginId}' is currently ${loaded.status}`,
      });
    }

    const pluginRoutes = this.routes.get(pluginId) ?? [];
    const normalizedPath = rawSubPath.startsWith("/")
      ? rawSubPath
      : `/${rawSubPath}`;
    const cleanPath = normalizedPath.split("?")[0] || "/";

    let matchedRoute: RegisteredRoute | null = null;
    let matchedParams: Record<string, string> = {};

    for (const route of pluginRoutes) {
      if (route.method !== "ALL" && route.method !== method) {
        continue;
      }

      const match = route.regex.exec(cleanPath);
      if (match) {
        matchedRoute = route;
        matchedParams = {};
        route.paramNames.forEach((name, idx) => {
          matchedParams[name] = decodeURIComponent(match[idx + 1] || "");
        });
        break;
      }
    }

    if (!matchedRoute) {
      throw createError({
        statusCode: 404,
        statusMessage: `No handler found for [${method}] ${cleanPath} in plugin '${pluginId}'`,
      });
    }

    let userId: string | undefined;
    let userAcls: string[] | undefined;
    try {
      const auth = await this.resolveAuth(event);
      userId = auth.userId;
      userAcls = auth.userAcls;
    } catch {
      // Unauthenticated callers receive undefined userId
    }

    const context: RouteHandlerContext = {
      params: matchedParams,
      query: getQuery(event),
      userId,
      userAcls,
    };

    return await matchedRoute.handler(event, context);
  }
}

export const pluginManager = new PluginManager();
export default pluginManager;
