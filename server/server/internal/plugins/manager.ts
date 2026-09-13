import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { H3Event } from "h3";
import { getQuery, createError } from "h3";
import type { Logger } from "pino";
import { logger } from "../logging";
import aclManager from "../acls";
import { systemConfig } from "../config/sys-conf";
import { FilePluginStorage } from "./storage";
import type {
  HttpMethod,
  PluginCapability,
  PluginContext,
  PluginManifest,
  PluginMetadata,
  PluginStateRecord,
  PluginStatus,
  RouteHandler,
  RouteHandlerContext,
  ServerPlugin,
} from "./types";

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
  private readonly eventBus = new EventEmitter();
  private readonly log: Logger = logger.child({ name: "plugin-manager" });

  constructor() {
    this.eventBus.setMaxListeners(200);
  }

  private getStateFilePath(): string {
    return path.join(systemConfig.getDataFolder(), "plugins", "_state.json");
  }

  private getPluginsDirectory(): string {
    return path.join(systemConfig.getDataFolder(), "plugins");
  }

  private async loadState(): Promise<Record<string, PluginStateRecord>> {
    try {
      const data = await fs.readFile(this.getStateFilePath(), "utf-8");
      return JSON.parse(data) as Record<string, PluginStateRecord>;
    } catch {
      return {};
    }
  }

  private async saveState(
    state: Record<string, PluginStateRecord>,
  ): Promise<void> {
    const filePath = this.getStateFilePath();
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

  private createPluginContext(plugin: ServerPlugin): PluginContext {
    const id = plugin.metadata.id;
    const pluginLogger = this.log.child({ plugin: id });
    const storage = new FilePluginStorage(id);
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
        if (!this.hasCapability(plugin.metadata.capabilities, "routes")) {
          pluginLogger.warn(
            `Plugin '${id}' attempted to register route '${pattern}' without 'routes' capability.`,
          );
          return;
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
        if (!this.hasCapability(plugin.metadata.capabilities, "events")) {
          pluginLogger.warn(
            `Plugin '${id}' attempted to broadcast on '${channel}' without 'events' capability.`,
          );
          return;
        }
        this.eventBus.emit(channel, event);
      },
      subscribe: (channel: string, listener: (event: unknown) => void) => {
        if (!this.hasCapability(plugin.metadata.capabilities, "events")) {
          pluginLogger.warn(
            `Plugin '${id}' attempted to subscribe to '${channel}' without 'events' capability.`,
          );
          return () => {};
        }
        this.eventBus.on(channel, listener);
        return () => {
          this.eventBus.off(channel, listener);
        };
      },
    };
  }

  async registerPlugin(plugin: ServerPlugin): Promise<void> {
    const id = plugin.metadata.id;
    if (this.plugins.has(id)) {
      this.log.warn(`Plugin ${id} is already registered, replacing`);
      await this.unregisterPlugin(id);
    }

    const state = await this.loadState();
    const isExplicitlyDisabled = state[id]?.enabled === false;

    const context = this.createPluginContext(plugin);
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
        const context = this.createPluginContext(loaded.plugin);
        loaded.context = context;
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
    const pluginsDir = this.getPluginsDirectory();
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
      userId = (await aclManager.getUserIdACL(event, [])) ?? undefined;
      const allAcls = await aclManager.fetchAllACLs(event);
      userAcls = allAcls ? Array.from(allAcls) : undefined;
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
