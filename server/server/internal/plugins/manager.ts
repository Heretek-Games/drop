import { EventEmitter } from "node:events";
import type { H3Event } from "h3";
import { getQuery, createError } from "h3";
import type { Logger } from "pino";
import { logger } from "../logging";
import aclManager from "../acls";
import { FilePluginStorage } from "./storage";
import type {
  HttpMethod,
  PluginContext,
  PluginMetadata,
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
  status: "active" | "error" | "registered";
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

  async registerPlugin(plugin: ServerPlugin): Promise<void> {
    const id = plugin.metadata.id;
    if (this.plugins.has(id)) {
      this.log.warn(`Plugin ${id} is already registered, replacing`);
      await this.unregisterPlugin(id);
    }

    const pluginLogger = this.log.child({ plugin: id });
    const storage = new FilePluginStorage(id);
    const pluginRoutes: RegisteredRoute[] = [];
    this.routes.set(id, pluginRoutes);

    const context: PluginContext = {
      id,
      logger: pluginLogger,
      storage,
      registerRoute: (
        method: HttpMethod,
        pattern: string,
        handler: RouteHandler,
      ) => {
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
        this.eventBus.emit(channel, event);
      },
      subscribe: (channel: string, listener: (event: unknown) => void) => {
        this.eventBus.on(channel, listener);
        return () => {
          this.eventBus.off(channel, listener);
        };
      },
    };

    const loaded: LoadedPlugin = {
      plugin,
      context,
      status: "registered",
    };
    this.plugins.set(id, loaded);

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

    if (loaded.plugin.teardown) {
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

  listPlugins(): Array<PluginMetadata & { status: string }> {
    return Array.from(this.plugins.values()).map((p) => ({
      ...p.plugin.metadata,
      status: p.status,
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
    if (!loaded || loaded.status !== "active") {
      throw createError({
        statusCode: 404,
        statusMessage: `Plugin '${pluginId}' not found or inactive`,
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
