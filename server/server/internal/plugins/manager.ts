import type { H3Event } from "h3";
import { createError } from "h3";
import type { Logger } from "pino";
import { logger } from "../logging";
import { PluginRegistry } from "./registry";
import { PluginEventBus } from "./events";
import { PluginRouteTable } from "./routes";
import { PluginWebSocketRegistry } from "./websocket";
import { PluginLifecycle } from "./lifecycle";
import {
  PluginSpiRegistry,
  createPluginContext as buildPluginContext,
} from "./context";
import type { PluginContextHost } from "./context";
import {
  checkForUpdates as checkBundledPluginUpdates,
  discoverAndLoadExternalPlugins as discoverExternalPlugins,
  getClientAssetPath as resolveClientAssetPath,
  installBundle as installPluginBundle,
  installFromUrl as installPluginFromUrl,
  reloadPlugins as reloadExternalPlugins,
  removeBundle as removePluginBundle,
} from "./bundle";
import type { PluginBundleHost, PluginUpdateInfo } from "./bundle";
import type {
  CloudSavePathResolver,
  MetadataProvider,
  PaymentGateway,
  PluginManifest,
  PluginMetadata,
  PluginStatus,
  PluginStorage,
  ServerPlugin,
  SubscriptionContext,
  WebSocketContext,
} from "./types";

/** Resolved caller identity passed to route handlers. */
export interface PluginAuthContext {
  userId?: string;
  userAcls?: string[];
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
  /**
   * Path to a plugin registry JSON (allow-list + version/checksum pinning).
   * Defaults to `DROP_PLUGIN_REGISTRY`; no registry by default.
   */
  registryPath?: string;
}

/**
 * Thin facade over the plugin runtime modules: route table, WebSocket
 * registry, event bus, SPI registry, lifecycle and bundle loader.
 */
export class PluginManager {
  private readonly options: PluginManagerOptions;
  private readonly log: Logger = logger.child({ name: "plugin-manager" });
  private readonly routes = new PluginRouteTable();
  private readonly webSockets = new PluginWebSocketRegistry();
  private readonly events = new PluginEventBus();
  private readonly spi = new PluginSpiRegistry();
  private readonly lifecycle: PluginLifecycle;
  private readonly contextHost: PluginContextHost;
  private readonly bundleHost: PluginBundleHost;

  constructor(options: PluginManagerOptions = {}) {
    this.options = options;
    this.contextHost = {
      routes: this.routes,
      webSockets: this.webSockets,
      events: this.events,
      spi: this.spi,
      log: this.log,
      createStorage: (pluginId) => this.createStorage(pluginId),
    };
    this.bundleHost = {
      log: this.log,
      getPluginsDirectory: () => this.lifecycle.getPluginsDirectory(),
      getRegistry: () => this.loadRegistry(),
      registerPlugin: (plugin) => this.registerPlugin(plugin),
      unregisterPlugin: (id) => this.unregisterPlugin(id),
      getPlugin: (id) => this.getPlugin(id),
      listPlugins: () => this.listPlugins(),
    };
    this.lifecycle = new PluginLifecycle({
      dataDir: options.dataDir,
      log: this.log,
      createContext: (plugin) => buildPluginContext(this.contextHost, plugin),
      releaseResources: (id) => this.releaseResources(id),
      notifyStateChange: (id, enabled) =>
        this.broadcast("plugins:state", { id, enabled }),
    });
  }

  private async createStorage(pluginId: string): Promise<PluginStorage> {
    if (this.options.storageFactory) {
      return this.options.storageFactory(pluginId);
    }
    const { FilePluginStorage } = await import("./storage");
    return new FilePluginStorage(pluginId, this.options.dataDir);
  }

  private async loadRegistry(): Promise<PluginRegistry> {
    const registryPath =
      this.options.registryPath ?? process.env.DROP_PLUGIN_REGISTRY;
    // Re-read on demand so provisioning or updating the registry file takes
    // effect without a process restart.
    return await PluginRegistry.load(registryPath);
  }

  /** Drop a plugin's routes, sockets, SPI entries and event subscriptions. */
  private releaseResources(id: string): void {
    this.routes.release(id);
    this.webSockets.release(id);
    this.spi.release(id);
    this.events.release(id);
  }

  private async resolveAuth(event: H3Event): Promise<PluginAuthContext> {
    if (this.options.authResolver) {
      return this.options.authResolver(event);
    }
    const { resolvePluginAuth } = await import("./auth");
    return await resolvePluginAuth(event);
  }

  async registerPlugin(plugin: ServerPlugin): Promise<void> {
    await this.lifecycle.register(plugin);
  }

  async unregisterPlugin(id: string): Promise<void> {
    await this.lifecycle.unregister(id);
  }

  async togglePlugin(id: string, enabled: boolean): Promise<boolean> {
    return await this.lifecycle.toggle(id, enabled);
  }

  async discoverAndLoadExternalPlugins(): Promise<void> {
    await discoverExternalPlugins(this.bundleHost);
  }

  async installBundle(
    manifest: PluginManifest,
    entryOrFiles: string | Record<string, string>,
  ): Promise<void> {
    await installPluginBundle(this.bundleHost, manifest, entryOrFiles);
  }

  async installFromUrl(url: string): Promise<void> {
    await installPluginFromUrl(this.bundleHost, url);
  }

  async checkForUpdates(): Promise<PluginUpdateInfo[]> {
    return await checkBundledPluginUpdates(this.bundleHost);
  }

  async removeBundle(id: string): Promise<boolean> {
    return await removePluginBundle(this.bundleHost, id);
  }

  async reloadPlugins(): Promise<void> {
    await reloadExternalPlugins(this.bundleHost);
  }

  listPlugins(): Array<
    PluginMetadata & {
      status: PluginStatus;
      error?: string;
    }
  > {
    return this.lifecycle.list();
  }

  getPlugin(id: string): ServerPlugin | undefined {
    return this.lifecycle.get(id);
  }

  broadcast(channel: string, data: unknown): void {
    this.events.emit(channel, data);
  }

  subscribe(channel: string, listener: (data: unknown) => void): () => void {
    return this.events.subscribe(channel, listener);
  }

  async canSubscribe(
    channel: string,
    context: SubscriptionContext,
  ): Promise<boolean> {
    return await this.webSockets.canSubscribe(channel, context);
  }

  async dispatchWebSocket(
    channel: string,
    message: unknown,
    context: WebSocketContext,
  ): Promise<boolean> {
    return await this.webSockets.dispatch(channel, message, context, (id) =>
      this.lifecycle.isActive(id),
    );
  }

  webSocketChannels(): string[] {
    return this.webSockets.channels();
  }

  isPublicChannel(channel: string): boolean {
    return this.webSockets.isPublicChannel(channel);
  }

  publicWebSocketChannels(): string[] {
    return this.webSockets.publicChannels();
  }

  getMetadataProviders(): MetadataProvider[] {
    return this.spi.getMetadataProviders();
  }

  getMetadataProvider(id: string): MetadataProvider | undefined {
    return this.spi.getMetadataProvider(id);
  }

  getCloudSaveResolvers(): CloudSavePathResolver[] {
    return this.spi.getCloudSaveResolvers();
  }

  getCloudSaveResolver(id: string): CloudSavePathResolver | undefined {
    return this.spi.getCloudSaveResolver(id);
  }

  getPaymentGateways(): PaymentGateway[] {
    return this.spi.getPaymentGateways();
  }

  getPaymentGateway(id: string): PaymentGateway | undefined {
    return this.spi.getPaymentGateway(id);
  }

  async getClientAssetPath(
    pluginId: string,
    assetRelPath: string,
  ): Promise<string | null> {
    return await resolveClientAssetPath(
      this.bundleHost,
      pluginId,
      assetRelPath,
    );
  }

  async dispatch(
    pluginId: string,
    method: string,
    rawSubPath: string,
    event: H3Event,
  ): Promise<unknown> {
    const loaded = this.lifecycle.getRecord(pluginId);
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

    return await this.routes.dispatch(
      pluginId,
      method,
      rawSubPath,
      event,
      (h3Event) => this.resolveAuth(h3Event),
    );
  }
}

export const pluginManager = new PluginManager();
export default pluginManager;
