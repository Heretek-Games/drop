import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
import { PluginRegistry } from "./registry";
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
  SubscriptionAuthorizer,
  SubscriptionContext,
  WebSocketContext,
  WebSocketHandler,
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

interface RegisteredRoute {
  method: HttpMethod;
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

interface SubscriptionAuthorizerEntry {
  matches: (channel: string) => boolean;
  authorize: SubscriptionAuthorizer;
}

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

function isValidPluginId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && PLUGIN_ID_PATTERN.test(id);
}

/** Whether a bundle-relative path is executable plugin code. */
function isBundleCodeFile(rel: string): boolean {
  const ext = path.extname(rel).toLowerCase();
  return ext === ".js" || ext === ".mjs" || ext === ".cjs";
}

/** True when `child` resolves inside (or equals) `parent`. */
function isInsideDirectory(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Strips trailing slashes without a backtracking-prone regular expression. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end--;
  }
  return value.slice(0, end);
}

/** Resolves a dynamically imported bundle's default or named plugin export. */
function resolvePluginExport(mod: {
  default?: unknown;
  plugin?: unknown;
}): ServerPlugin | null {
  const defaultExport = mod.default as Partial<ServerPlugin> | undefined;
  if (defaultExport && typeof defaultExport.init === "function") {
    return defaultExport as ServerPlugin;
  }
  const namedExport = mod.plugin as Partial<ServerPlugin> | undefined;
  if (namedExport && typeof namedExport.init === "function") {
    return namedExport as ServerPlugin;
  }
  if (typeof mod.default === "function") {
    return new (mod.default as new () => ServerPlugin)();
  }
  return null;
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
  private readonly subscriptionAuthorizers = new Map<
    string,
    SubscriptionAuthorizerEntry[]
  >();
  private readonly eventBus = new EventEmitter();
  private readonly pluginEventSubscriptions = new Map<
    string,
    Array<() => void>
  >();
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

    const regexStr = trimTrailingSlashes(normalized)
      .replace(/:(\w+)/g, (_, name) => {
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
    // Fail closed: a plugin that does not explicitly declare a capability
    // cannot use it.
    return capabilities?.includes(cap) ?? false;
  }

  private async createStorage(pluginId: string): Promise<PluginStorage> {
    if (this.options.storageFactory) {
      return this.options.storageFactory(pluginId);
    }
    const { FilePluginStorage } = await import("./storage");
    return new FilePluginStorage(pluginId, this.options.dataDir);
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
    this.pluginEventSubscriptions.set(id, []);

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
        const off = () => {
          this.eventBus.off(channel, listener);
        };
        const subscriptions = this.pluginEventSubscriptions.get(id) ?? [];
        subscriptions.push(off);
        this.pluginEventSubscriptions.set(id, subscriptions);
        return off;
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
      registerSubscriptionAuthorizer: (
        matches: (channel: string) => boolean,
        authorize: SubscriptionAuthorizer,
      ) => {
        if (!this.hasCapability(capabilities, "websocket")) {
          throw new PluginCapabilityError(
            id,
            "websocket",
            "registerSubscriptionAuthorizer",
          );
        }
        const entries = this.subscriptionAuthorizers.get(id) ?? [];
        entries.push({ matches, authorize });
        this.subscriptionAuthorizers.set(id, entries);
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
   * Verify an external bundle's entry file.
   *
   * `checksum` (if present) must match the entry file's SHA-256. Signature and
   * whole-bundle verification happen in {@link verifyBundleFiles} and
   * {@link verifyBundleSignature} once the bundle contents are known.
   */
  private verifyBundleBytes(bytes: Buffer, manifest: PluginManifest): string {
    const digest = createHash("sha256").update(bytes).digest("hex");

    if (
      manifest.checksum &&
      (!SHA256_HEX_PATTERN.test(manifest.checksum) ||
        !constantTimeEqual(manifest.checksum, digest))
    ) {
      throw new Error(
        `bundle checksum mismatch for ${manifest.id}: expected ${manifest.checksum}, found ${digest}`,
      );
    }
    return digest;
  }

  /**
   * Verify every importable file in a bundle and return an aggregate digest
   * used to cache-bust the entry import.
   *
   * A bundle with more than one code file must declare `files` checksums; a
   * single-file bundle may rely on the entry `checksum`. Values in `files`
   * must match and cover every code file, so relative imports cannot smuggle
   * unverified modules into the process.
   */
  private async verifyBundleFiles(
    pluginDir: string,
    manifest: PluginManifest,
  ): Promise<string> {
    const root = path.resolve(pluginDir);
    const files = await this.listBundleFiles(root);
    const codeFiles = files.filter(isBundleCodeFile);

    if (manifest.files) {
      await this.verifyDeclaredBundleFiles(root, files, manifest.files);
      for (const rel of codeFiles) {
        if (!(rel in manifest.files)) {
          throw new Error(
            `bundle file '${rel}' is not covered by the manifest 'files' checksums`,
          );
        }
      }
    } else if (codeFiles.length > 1) {
      throw new Error(
        `bundle '${manifest.id}' contains multiple code files but no 'files' checksums; refusing unverified imports`,
      );
    }

    return await this.aggregateBundleDigest(root, files);
  }

  /** Verify every declared `files` entry against the bundle on disk. */
  private async verifyDeclaredBundleFiles(
    root: string,
    files: string[],
    declared: Record<string, string>,
  ): Promise<void> {
    for (const [rel, expected] of Object.entries(declared)) {
      const resolved = path.resolve(root, rel);
      if (path.isAbsolute(rel) || !isInsideDirectory(root, resolved)) {
        throw new Error(`invalid bundle file path '${rel}'`);
      }
      if (!files.includes(rel)) {
        throw new Error(`bundle manifest lists missing file '${rel}'`);
      }
      const digest = createHash("sha256")
        .update(await fs.readFile(resolved))
        .digest("hex");
      if (
        !SHA256_HEX_PATTERN.test(expected) ||
        !constantTimeEqual(expected, digest)
      ) {
        throw new Error(`bundle file checksum mismatch for ${rel}`);
      }
    }
  }

  /** SHA-256 over every bundle file, used to cache-bust the entry import. */
  private async aggregateBundleDigest(
    root: string,
    files: string[],
  ): Promise<string> {
    const hasher = createHash("sha256");
    for (const rel of files) {
      const bytes = await fs.readFile(path.join(root, rel));
      hasher.update(rel);
      hasher.update("\0");
      hasher.update(String(bytes.length));
      hasher.update("\0");
      hasher.update(bytes);
    }
    return hasher.digest("hex");
  }

  /** Recursively list bundle files, ignoring installed dependencies. */
  private async listBundleFiles(root: string, prefix = ""): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.readdir(path.join(root, prefix), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        results.push(...(await this.listBundleFiles(root, rel)));
      } else if (entry.isFile()) {
        // The manifest cannot checksum itself; the signer excludes it too.
        if (!prefix && entry.name === "drop-plugin.json") continue;
        results.push(rel);
      }
    }
    return results.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Verify the bundle signature. When `files` is present the signature covers
   * the aggregate bundle digest; otherwise it covers the entry checksum
   * (legacy single-file bundles). `DROP_PLUGIN_REQUIRE_SIGNATURE=true` refuses
   * unsigned bundles.
   */
  private verifyBundleSignature(
    aggregateDigest: string,
    entryDigest: string,
    manifest: PluginManifest,
  ): void {
    const signingKey = process.env.DROP_PLUGIN_SIGNING_KEY;
    if (manifest.signature) {
      if (!signingKey) {
        throw new Error(
          `bundle ${manifest.id} is signed but DROP_PLUGIN_SIGNING_KEY is not set`,
        );
      }
      const covered = manifest.files ? aggregateDigest : entryDigest;
      const expected = createHmac("sha256", signingKey)
        .update(covered)
        .digest("hex");
      if (
        !SHA256_HEX_PATTERN.test(manifest.signature) ||
        !constantTimeEqual(expected, manifest.signature)
      ) {
        throw new Error(`bundle signature mismatch for ${manifest.id}`);
      }
    } else if (process.env.DROP_PLUGIN_REQUIRE_SIGNATURE === "true") {
      throw new Error(`bundle ${manifest.id} is unsigned`);
    }
  }

  private async getRegistry(): Promise<PluginRegistry> {
    const registryPath =
      this.options.registryPath ?? process.env.DROP_PLUGIN_REGISTRY;
    // Re-read on demand so provisioning or updating the registry file takes
    // effect without a process restart.
    return await PluginRegistry.load(registryPath);
  }

  /** Verify, import and register a bundle directory. */
  private async loadExternalPluginFromDir(
    pluginDir: string,
    manifest: PluginManifest,
  ): Promise<void> {
    if (!isValidPluginId(manifest.id)) {
      throw new Error(`invalid plugin id '${manifest.id}'`);
    }
    const entryRel = manifest.entry || "index.js";
    const entryPath = path.resolve(pluginDir, entryRel);
    if (
      path.isAbsolute(entryRel) ||
      !isInsideDirectory(path.resolve(pluginDir), entryPath)
    ) {
      throw new Error(`invalid entry path '${entryRel}'`);
    }

    // Validate the declared contract *before* importing: a dynamic import runs
    // the module's top-level code, so compatibility must be checked on the
    // manifest, not after the module has already executed.
    this.assertManifestCompatible(manifest);

    const entryDigest = this.verifyBundleBytes(
      await fs.readFile(entryPath),
      manifest,
    );
    const aggregateDigest = await this.verifyBundleFiles(pluginDir, manifest);
    this.verifyBundleSignature(aggregateDigest, entryDigest, manifest);
    (await this.getRegistry()).check(manifest, entryDigest);

    // Version the import URL by the whole-bundle digest so a change to any
    // file (not just the entry) forces a fresh entry module instance.
    const mod = await import(
      `${pathToFileURL(entryPath).href}?v=${aggregateDigest}`
    );
    const pluginInstance = resolvePluginExport(mod);

    if (!pluginInstance) {
      throw new Error(
        `Plugin module at ${entryPath} does not export a valid ServerPlugin`,
      );
    }

    pluginInstance.metadata = {
      ...manifest,
      builtin: false,
    };

    await this.registerPlugin(pluginInstance);
  }

  /** Validate a manifest's declared contract before importing its module. */
  private assertManifestCompatible(manifest: PluginManifest): void {
    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
      throw new PluginApiVersionError(
        manifest.id,
        PLUGIN_API_VERSION,
        manifest.apiVersion ?? 0,
      );
    }
    if (manifest.trust !== undefined && manifest.trust !== "trusted") {
      throw new PluginTrustError(manifest.id, manifest.trust);
    }
  }

  private assertPluginCompatible(plugin: ServerPlugin): void {
    const { id, apiVersion, trust } = plugin.metadata;
    // Every plugin must declare the contract version it was built against;
    // omitting it previously bypassed the compatibility gate entirely.
    if (apiVersion !== PLUGIN_API_VERSION) {
      throw new PluginApiVersionError(id, PLUGIN_API_VERSION, apiVersion ?? 0);
    }
    if (trust !== undefined && trust !== "trusted") {
      throw new PluginTrustError(id, trust);
    }
  }

  async registerPlugin(plugin: ServerPlugin): Promise<void> {
    const id = plugin.metadata.id;
    if (!isValidPluginId(id)) {
      throw new Error(`invalid plugin id '${id}'`);
    }
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

    this.releasePluginResources(id);
    this.plugins.delete(id);
    this.log.info(`Plugin ${id} unregistered`);
  }

  /** Drop a plugin's routes, sockets and event subscriptions. */
  private releasePluginResources(id: string): void {
    this.routes.delete(id);
    for (const [channel, entry] of this.webSockets) {
      if (entry.pluginId === id) {
        this.webSockets.delete(channel);
      }
    }
    this.subscriptionAuthorizers.delete(id);
    const subscriptions = this.pluginEventSubscriptions.get(id) ?? [];
    for (const off of subscriptions) {
      off();
    }
    this.pluginEventSubscriptions.delete(id);
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

    if (enabled) {
      await this.enablePlugin(id, loaded);
    } else {
      await this.disablePlugin(id, loaded);
    }

    return true;
  }

  private async disablePlugin(id: string, loaded: LoadedPlugin): Promise<void> {
    if (loaded.status !== "active") return;

    if (loaded.plugin.teardown) {
      try {
        await loaded.plugin.teardown();
      } catch (err) {
        this.log.warn(`Error tearing down plugin ${id}: ${err}`);
      }
    }
    this.releasePluginResources(id);
    loaded.status = "disabled";
    this.log.info(`Plugin '${id}' disabled`);
    this.broadcast("plugins:state", { id, enabled: false });
  }

  private async enablePlugin(id: string, loaded: LoadedPlugin): Promise<void> {
    if (loaded.status === "active") return;

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

  async discoverAndLoadExternalPlugins(): Promise<void> {
    const pluginsDir = await this.getPluginsDirectory();
    try {
      await fs.mkdir(pluginsDir, { recursive: true });
      const entries = await fs.readdir(pluginsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        await this.loadExternalPluginEntry(path.join(pluginsDir, entry.name));
      }
    } catch (err) {
      this.log.debug(`External plugins directory check: ${err}`);
    }
  }

  private async loadExternalPluginEntry(pluginDir: string): Promise<void> {
    const manifestContent = await this.readExternalManifest(pluginDir);
    if (!manifestContent) return;

    try {
      const manifest: PluginManifest = JSON.parse(manifestContent);
      if (
        !manifest.id ||
        !manifest.name ||
        !manifest.version ||
        !isValidPluginId(manifest.id)
      ) {
        this.log.warn(`Invalid plugin manifest in ${pluginDir}`);
        return;
      }

      if (this.plugins.has(manifest.id)) {
        return;
      }

      await this.loadExternalPluginFromDir(pluginDir, manifest);
    } catch (err) {
      this.log.error(
        `Failed to load external plugin from ${pluginDir}: ${err}`,
      );
    }
  }

  private async readExternalManifest(
    pluginDir: string,
  ): Promise<string | undefined> {
    try {
      return await fs.readFile(
        path.join(pluginDir, "drop-plugin.json"),
        "utf-8",
      );
    } catch {
      try {
        return await fs.readFile(path.join(pluginDir, "plugin.json"), "utf-8");
      } catch {
        return undefined;
      }
    }
  }

  /**
   * Install (or update) a signed plugin bundle from its manifest and entry
   * source, verifying the checksum/signature before writing or loading.
   */
  async installBundle(
    manifest: PluginManifest,
    entryBase64: string,
  ): Promise<void> {
    if (!manifest.id || !manifest.name || !manifest.version) {
      throw new Error("manifest requires id, name and version");
    }
    if (!isValidPluginId(manifest.id)) {
      throw new Error("invalid plugin id");
    }

    const bytes = Buffer.from(entryBase64, "base64");
    const digest = this.verifyBundleBytes(bytes, manifest);
    (await this.getRegistry()).check(manifest, digest);

    const pluginsDir = await this.getPluginsDirectory();
    const bundleDir = path.join(pluginsDir, manifest.id);
    const entryRel = manifest.entry || "index.js";
    const entryPath = path.resolve(bundleDir, entryRel);
    if (
      path.isAbsolute(entryRel) ||
      !isInsideDirectory(path.resolve(bundleDir), entryPath)
    ) {
      throw new Error("invalid entry path");
    }

    await fs.mkdir(bundleDir, { recursive: true });

    const storedManifest: PluginManifest = {
      ...manifest,
      checksum: manifest.checksum ?? digest,
    };
    await fs.writeFile(
      path.join(bundleDir, "drop-plugin.json"),
      JSON.stringify(storedManifest, null, 2),
    );
    await fs.writeFile(entryPath, bytes);

    await this.loadExternalPluginFromDir(bundleDir, storedManifest);
  }

  /** Remove an external plugin bundle and unregister it. */
  async removeBundle(id: string): Promise<boolean> {
    if (!isValidPluginId(id)) {
      throw new Error("invalid plugin id");
    }
    const loaded = this.plugins.get(id);
    if (loaded?.plugin.metadata.builtin) {
      throw new Error("cannot remove a builtin plugin");
    }

    await this.unregisterPlugin(id);

    const pluginsDir = await this.getPluginsDirectory();
    await fs.rm(path.join(pluginsDir, id), { recursive: true, force: true });
    return true;
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

  /**
   * Whether a client may subscribe to `channel`. Only authorizers whose
   * `matches` accepts the channel are consulted; when none match the channel
   * is allowed (the gateway still requires authentication for non-public
   * channels).
   */
  async canSubscribe(
    channel: string,
    context: SubscriptionContext,
  ): Promise<boolean> {
    const matching: SubscriptionAuthorizer[] = [];
    for (const entries of this.subscriptionAuthorizers.values()) {
      for (const entry of entries) {
        if (entry.matches(channel)) matching.push(entry.authorize);
      }
    }
    if (matching.length === 0) return true;
    for (const authorize of matching) {
      if (await authorize(channel, context)) return true;
    }
    return false;
  }

  /** Route a client WebSocket message to the plugin that claimed the channel. */
  async dispatchWebSocket(
    channel: string,
    message: unknown,
    context: WebSocketContext,
  ): Promise<boolean> {
    const entry = this.webSockets.get(channel);
    if (!entry) return false;
    const loaded = this.plugins.get(entry.pluginId);
    if (loaded?.status !== "active") return false;
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
    const { resolvePluginAuth } = await import("./auth");
    return await resolvePluginAuth(event);
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
