import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { H3Event } from "h3";
import { getQuery, createError, readBody } from "h3";
import type { Logger } from "pino";
import { logger } from "../logging";
import {
  PluginApiVersionError,
  PluginCapabilityError,
  PluginTrustError,
} from "./errors";
import { PluginRegistry } from "./registry";
import { SIGNATURE_VERSION, signaturePayloadV2 } from "./signature";
import { PLUGIN_API_VERSION, SUPPORTED_API_VERSIONS } from "./types";
import {
  PLUGIN_SETTINGS_STORAGE_KEY,
  applySettingsDefaults,
  mergeSettingsPayload,
  normalizeSettingsSchema,
  redactSettingsValues,
  validateSettingsValues,
} from "./settings";
import type {
  AuthProvider,
  CloudSavePathResolver,
  DepotStorageProvider,
  HttpMethod,
  MetadataProvider,
  PaymentGateway,
  PluginCapability,
  PluginSidecar,
  PluginContext,
  PluginManifest,
  PluginMetadata,
  PluginStateRecord,
  PluginStatus,
  PluginStorage,
  PluginSettingsSchema,
  RouteHandler,
  RouteHandlerContext,
  ServerPlugin,
  SubscriptionAuthorizer,
  SubscriptionContext,
  WebSocketContext,
  WebSocketHandler,
  WebSocketOptions,
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

/** Upper bound on a plugin route pattern, limiting regex construction cost. */
const MAX_ROUTE_PATTERN_LENGTH = 512;

/** Escapes RegExp metacharacters so literal route text cannot form a pattern. */
function escapeRegExp(value: string): string {
  const specials = ".*+?^${}()|[]\\";
  let escaped = "";
  for (const char of value) {
    escaped += specials.includes(char) ? `\\${char}` : char;
  }
  return escaped;
}

/**
 * Translates one token of a plugin route pattern into regex source. Recognises
 * `:name`, `*`, and `**`; every other character is escaped so it stays literal.
 */
function routeTokenToRegexSource(
  normalized: string,
  index: number,
  paramNames: string[],
): { source: string; consumed: number } {
  const char = normalized[index];
  if (char === ":" && /\w/.test(normalized[index + 1] ?? "")) {
    let end = index + 1;
    while (end < normalized.length && /\w/.test(normalized[end])) {
      end++;
    }
    paramNames.push(normalized.slice(index + 1, end));
    return { source: "([^/]+)", consumed: end - index };
  }
  if (char === "*") {
    return normalized[index + 1] === "*"
      ? { source: "(.*)", consumed: 2 }
      : { source: "([^/]+)", consumed: 1 };
  }
  return { source: escapeRegExp(char), consumed: 1 };
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

function isIgnoredBundleFile(prefix: string, name: string): boolean {
  if (prefix) return false;
  return (
    name === "drop-plugin.json" ||
    name === "state.json" ||
    name === "schema.json"
  );
}

export class PluginManager {
  private readonly plugins = new Map<string, LoadedPlugin>();
  /**
   * Memoized storage instances per plugin so the guarded context storage and
   * host-managed settings reads/writes share one in-memory cache and cannot
   * observe stale copies of `state.json`.
   */
  private readonly storageInstances = new Map<string, PluginStorage>();
  private readonly routes = new Map<string, RegisteredRoute[]>();
  private readonly webSockets = new Map<
    string,
    { pluginId: string; handler: WebSocketHandler }
  >();
  private readonly publicChannels = new Map<string, string>(); // channel -> pluginId
  private readonly subscriptionAuthorizers = new Map<
    string,
    SubscriptionAuthorizerEntry[]
  >();
  private readonly eventBus = new EventEmitter();
  private readonly pluginEventSubscriptions = new Map<
    string,
    Array<() => void>
  >();
  private readonly metadataProviders = new Map<
    string,
    { pluginId: string; provider: MetadataProvider }
  >();
  private readonly cloudSaveResolvers = new Map<
    string,
    { pluginId: string; resolver: CloudSavePathResolver }
  >();
  private readonly paymentGateways = new Map<
    string,
    { pluginId: string; gateway: PaymentGateway }
  >();
  private readonly authProviders = new Map<
    string,
    { pluginId: string; provider: AuthProvider }
  >();
  private readonly depotProviders = new Map<
    string,
    { pluginId: string; provider: DepotStorageProvider }
  >();
  /** Recurring plugin tasks keyed by `<pluginId>:<taskName>`. */
  private readonly scheduledTasks = new Map<
    string,
    { pluginId: string; timer: NodeJS.Timeout }
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
    if (pattern.length > MAX_ROUTE_PATTERN_LENGTH) {
      throw new Error(
        `Plugin route pattern exceeds ${MAX_ROUTE_PATTERN_LENGTH} characters`,
      );
    }
    const paramNames: string[] = [];
    const normalized = trimTrailingSlashes(
      pattern.startsWith("/") ? pattern : `/${pattern}`,
    );

    // Build the pattern token-by-token and escape every literal character, so
    // a plugin cannot inject regex metacharacters (and thus a ReDoS payload)
    // through a route pattern.
    let source = "";
    for (let index = 0; index < normalized.length;) {
      const token = routeTokenToRegexSource(normalized, index, paramNames);
      source += token.source;
      index += token.consumed;
    }

    return {
      // Safe: `source` is assembled token-by-token by routeTokenToRegexSource,
      // which escapes every literal character, so a plugin route pattern can
      // never inject regex metacharacters or catastrophic backtracking groups.
      regex: Reflect.construct(RegExp, [`^${source || "/"}(?:/)?$`]) as RegExp,
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

  /** Returns the memoized (unguarded) storage instance for `pluginId`. */
  private async getStorageInstance(pluginId: string): Promise<PluginStorage> {
    const existing = this.storageInstances.get(pluginId);
    if (existing) return existing;
    const created = await this.createStorage(pluginId);
    this.storageInstances.set(pluginId, created);
    return created;
  }

  /** Reads + default-fills the host-managed settings for `pluginId`. */
  private async readSettingsFor(
    pluginId: string,
    schema: PluginSettingsSchema | undefined,
  ): Promise<Record<string, unknown>> {
    if (!schema) return {};
    const storage = await this.getStorageInstance(pluginId);
    const stored = await storage.get<Record<string, unknown>>(
      PLUGIN_SETTINGS_STORAGE_KEY,
    );
    return applySettingsDefaults(schema, stored);
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
      await this.getStorageInstance(id),
    );
    const pluginRoutes: RegisteredRoute[] = [];
    this.routes.set(id, pluginRoutes);
    this.pluginEventSubscriptions.set(id, []);

    return {
      id,
      logger: pluginLogger,
      storage,
      settings: await this.readSettingsFor(
        id,
        normalizeSettingsSchema(plugin.metadata.settingsSchema),
      ),
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
      registerWebSocket: (
        channel: string,
        handler: WebSocketHandler,
        options?: WebSocketOptions,
      ) => {
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
        if (options?.public) {
          this.publicChannels.set(channel, id);
        }
      },
      registerPublicWebSocketChannel: (channel: string) => {
        if (!this.hasCapability(capabilities, "websocket")) {
          throw new PluginCapabilityError(
            id,
            "websocket",
            `registerPublicWebSocketChannel(${channel})`,
          );
        }
        this.publicChannels.set(channel, id);
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
      registerMetadataProvider: (provider: MetadataProvider) => {
        if (
          !provider ||
          typeof provider.id !== "string" ||
          !provider.id.trim()
        ) {
          throw new Error("Metadata provider must have a valid non-empty id");
        }
        if (!this.hasCapability(capabilities, "metadata:provider")) {
          throw new PluginCapabilityError(
            id,
            "metadata:provider",
            `registerMetadataProvider(${provider.id})`,
          );
        }
        const existing = this.metadataProviders.get(provider.id);
        if (existing && existing.pluginId !== id) {
          throw new Error(
            `Metadata provider '${provider.id}' is already claimed by plugin '${existing.pluginId}'`,
          );
        }
        this.metadataProviders.set(provider.id, { pluginId: id, provider });
        pluginLogger.debug(`Registered metadata provider: ${provider.id}`);
      },
      registerCloudSaveResolver: (resolver: CloudSavePathResolver) => {
        if (
          !resolver ||
          typeof resolver.id !== "string" ||
          !resolver.id.trim()
        ) {
          throw new Error("Cloud save resolver must have a valid non-empty id");
        }
        if (!this.hasCapability(capabilities, "cloudsave:provider")) {
          throw new PluginCapabilityError(
            id,
            "cloudsave:provider",
            `registerCloudSaveResolver(${resolver.id})`,
          );
        }
        const existing = this.cloudSaveResolvers.get(resolver.id);
        if (existing && existing.pluginId !== id) {
          throw new Error(
            `Cloud save resolver '${resolver.id}' is already claimed by plugin '${existing.pluginId}'`,
          );
        }
        this.cloudSaveResolvers.set(resolver.id, {
          pluginId: id,
          resolver,
        });
        pluginLogger.debug(`Registered cloud save resolver: ${resolver.id}`);
      },
      registerPaymentGateway: (gateway: PaymentGateway) => {
        if (!gateway || typeof gateway.id !== "string" || !gateway.id.trim()) {
          throw new Error("Payment gateway must have a valid non-empty id");
        }
        if (!this.hasCapability(capabilities, "commerce:payment")) {
          throw new PluginCapabilityError(
            id,
            "commerce:payment",
            `registerPaymentGateway(${gateway.id})`,
          );
        }
        const existing = this.paymentGateways.get(gateway.id);
        if (existing && existing.pluginId !== id) {
          throw new Error(
            `Payment gateway '${gateway.id}' is already claimed by plugin '${existing.pluginId}'`,
          );
        }
        this.paymentGateways.set(gateway.id, { pluginId: id, gateway });
        pluginLogger.debug(`Registered payment gateway: ${gateway.id}`);
      },
      registerAuthProvider: (provider: AuthProvider) => {
        if (
          !provider ||
          typeof provider.id !== "string" ||
          !provider.id.trim()
        ) {
          throw new Error("Auth provider must have a valid non-empty id");
        }
        if (!this.hasCapability(capabilities, "auth:provider")) {
          throw new PluginCapabilityError(
            id,
            "auth:provider",
            `registerAuthProvider(${provider.id})`,
          );
        }
        const existing = this.authProviders.get(provider.id);
        if (existing && existing.pluginId !== id) {
          throw new Error(
            `Auth provider '${provider.id}' is already claimed by plugin '${existing.pluginId}'`,
          );
        }
        this.authProviders.set(provider.id, { pluginId: id, provider });
        pluginLogger.debug(`Registered auth provider: ${provider.id}`);
      },
      registerDepotProvider: (provider: DepotStorageProvider) => {
        if (
          !provider ||
          typeof provider.id !== "string" ||
          !provider.id.trim()
        ) {
          throw new Error("Depot provider must have a valid non-empty id");
        }
        if (!this.hasCapability(capabilities, "storage:depot")) {
          throw new PluginCapabilityError(
            id,
            "storage:depot",
            `registerDepotProvider(${provider.id})`,
          );
        }
        const existing = this.depotProviders.get(provider.id);
        if (existing && existing.pluginId !== id) {
          throw new Error(
            `Depot provider '${provider.id}' is already claimed by plugin '${existing.pluginId}'`,
          );
        }
        this.depotProviders.set(provider.id, { pluginId: id, provider });
        pluginLogger.debug(`Registered depot provider: ${provider.id}`);
      },
      scheduleTask: (
        name: string,
        intervalMs: number,
        task: () => Promise<void> | void,
      ) => {
        const key = `${id}:${name}`;
        const existing = this.scheduledTasks.get(key);
        if (existing) {
          clearInterval(existing.timer);
        }
        const timer = setInterval(
          () => {
            void Promise.resolve()
              .then(task)
              .catch((err: unknown) => {
                pluginLogger.error(
                  `Scheduled task '${name}' failed: ${String(err)}`,
                );
              });
          },
          Math.max(1, intervalMs),
        );
        timer.unref?.();
        this.scheduledTasks.set(key, { pluginId: id, timer });
        return () => {
          const entry = this.scheduledTasks.get(key);
          if (entry) {
            clearInterval(entry.timer);
            this.scheduledTasks.delete(key);
          }
        };
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

    await this.verifySidecarMetadata(root, manifest, files);
    return await this.aggregateBundleDigest(root, files);
  }

  /**
   * Validate the `client.sidecars` declaration for an installed bundle:
   * every target path must be a present regular file covered by the declared
   * `files` checksums (including the sidecar `sha256`), confined inside the
   * bundle, and each sidecar `name` must be allowlisted in `client.commands`.
   */
  private async verifySidecarMetadata(
    root: string,
    manifest: PluginManifest,
    files: string[],
  ): Promise<void> {
    const sidecars = manifest.client?.sidecars;
    if (sidecars === undefined) return;
    if (!Array.isArray(sidecars) || sidecars.length === 0) {
      throw new Error(
        `bundle ${manifest.id}: client.sidecars must be a non-empty array when declared`,
      );
    }
    if (!manifest.files) {
      throw new Error(
        `bundle ${manifest.id}: client.sidecars requires manifest 'files' checksums`,
      );
    }

    const commands = new Set<string>(manifest.client?.commands ?? []);
    for (const [idx, sidecar] of sidecars.entries()) {
      const label = `client.sidecars[${idx}]`;
      this.assertSidecarShape(manifest, label, sidecar, commands);
      await this.assertSidecarTargets(root, manifest, label, sidecar, files);
    }
  }

  /** Validate one sidecar declaration's shape and allowlist membership. */
  private assertSidecarShape(
    manifest: PluginManifest,
    label: string,
    sidecar: PluginSidecar | undefined,
    commands: Set<string>,
  ): asserts sidecar is PluginSidecar {
    if (typeof sidecar?.name !== "string" || !Array.isArray(sidecar.targets)) {
      throw new Error(
        `bundle ${manifest.id}: ${label} must declare { name: string, targets: array }`,
      );
    }
    if (!commands.has(sidecar.name)) {
      throw new Error(
        `bundle ${manifest.id}: ${label} sidecar name '${sidecar.name}' must be allowlisted in client.commands`,
      );
    }
  }

  /** Validate each declared sidecar target against the bundle on disk. */
  private async assertSidecarTargets(
    root: string,
    manifest: PluginManifest,
    label: string,
    sidecar: PluginSidecar,
    files: string[],
  ): Promise<void> {
    const seenTargets = new Set<string>();
    for (const [tIdx, target] of sidecar.targets.entries()) {
      const tLabel = `${label}.targets[${tIdx}]`;
      const key = `${target.os}-${target.arch}`;
      if (seenTargets.has(key)) {
        throw new Error(
          `bundle ${manifest.id}: ${tLabel} duplicate target '${key}' (only one binary per os+arch)`,
        );
      }
      seenTargets.add(key);
      await this.assertSidecarTargetPath(root, manifest, tLabel, target, files);
      await this.assertSidecarTargetDigest(root, manifest, tLabel, target);
    }
  }

  /** Validate one sidecar target's path containment and file presence. */
  private async assertSidecarTargetPath(
    root: string,
    manifest: PluginManifest,
    tLabel: string,
    target: { path: string },
    files: string[],
  ): Promise<void> {
    const resolved = path.resolve(root, target.path);
    if (
      typeof target.path !== "string" ||
      path.isAbsolute(target.path) ||
      !isInsideDirectory(root, resolved)
    ) {
      throw new Error(
        `bundle ${manifest.id}: ${tLabel} path must be a bundle-relative path`,
      );
    }
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error(
        `bundle ${manifest.id}: ${tLabel} declared sidecar file missing: ${target.path}`,
      );
    }
    if (!files.includes(target.path)) {
      throw new Error(
        `bundle ${manifest.id}: ${tLabel} file '${target.path}' is not covered by the manifest 'files' checksums`,
      );
    }
  }

  /** Verify one sidecar target's cited sha256 against the file on disk. */
  private async assertSidecarTargetDigest(
    root: string,
    manifest: PluginManifest,
    tLabel: string,
    target: { path: string; sha256: string },
  ): Promise<void> {
    const resolved = path.resolve(root, target.path);
    const digest = createHash("sha256")
      .update(await fs.readFile(resolved))
      .digest("hex");
    if (
      typeof target.sha256 !== "string" ||
      !SHA256_HEX_PATTERN.test(target.sha256) ||
      !constantTimeEqual(target.sha256, digest)
    ) {
      throw new Error(
        `bundle ${manifest.id}: ${tLabel} sha256 mismatch for ${target.path}`,
      );
    }
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

  /** Recursively list bundle files, ignoring installed dependencies and manifest/storage files. */
  private async listBundleFiles(root: string, prefix = ""): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.readdir(path.join(root, prefix), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules") {
        const subPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        results.push(...(await this.listBundleFiles(root, subPrefix)));
      } else if (entry.isFile() && !isIgnoredBundleFile(prefix, entry.name)) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        results.push(rel);
      }
    }
    return results.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Reconstruct the payload a bundle signature covers. Signature v2 covers the
   * canonical manifest in addition to the file aggregate; legacy bundles (no
   * marker) cover the file aggregate, or the entry checksum for single-file
   * bundles.
   */
  private resolveSignedPayload(
    aggregateDigest: string,
    entryDigest: string,
    manifest: PluginManifest,
  ): string {
    if (manifest.signatureVersion === SIGNATURE_VERSION) {
      if (!manifest.files) {
        throw new Error(
          `bundle ${manifest.id} declares signatureVersion ${SIGNATURE_VERSION} without file checksums`,
        );
      }
      return signaturePayloadV2(
        aggregateDigest,
        manifest as unknown as Record<string, unknown>,
      );
    }
    if (manifest.signatureVersion !== undefined) {
      throw new Error(
        `bundle ${manifest.id} uses unsupported signatureVersion ${manifest.signatureVersion}`,
      );
    }
    return manifest.files ? aggregateDigest : entryDigest;
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
      const covered = this.resolveSignedPayload(
        aggregateDigest,
        entryDigest,
        manifest,
      );
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

    // Check if plugin targets server (default true for v1 or when targets includes 'server')
    const targets = manifest.targets;
    const targetsServer = !targets || targets.includes("server");
    const entryRel = manifest.server?.entry || manifest.entry || "index.js";
    const entryPath = path.resolve(pluginDir, entryRel);
    if (
      targetsServer &&
      (path.isAbsolute(entryRel) ||
        !isInsideDirectory(path.resolve(pluginDir), entryPath))
    ) {
      throw new Error(`invalid entry path '${entryRel}'`);
    }

    // Validate the declared contract *before* importing: a dynamic import runs
    // the module's top-level code, so compatibility must be checked on the
    // manifest, not after the module has already executed.
    this.assertManifestCompatible(manifest);

    let entryDigest = "";
    if (targetsServer) {
      entryDigest = this.verifyBundleBytes(
        await fs.readFile(entryPath),
        manifest,
      );
    }
    const aggregateDigest = await this.verifyBundleFiles(pluginDir, manifest);
    this.verifyBundleSignature(aggregateDigest, entryDigest, manifest);
    (await this.getRegistry()).check(manifest, entryDigest);

    if (targetsServer) {
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
    } else {
      // Client-only plugin registered for discovery and asset serving
      const clientOnlyPlugin: ServerPlugin = {
        metadata: {
          ...manifest,
          builtin: false,
        },
        init: () => {},
      };
      await this.registerPlugin(clientOnlyPlugin);
    }
  }

  /**
   * Resolve an on-disk asset for client-side bundle serving.
   * Path traversal or symlink escapes outside the plugin directory return null.
   */
  async getClientAssetPath(
    pluginId: string,
    assetRelPath: string,
  ): Promise<string | null> {
    if (!isValidPluginId(pluginId)) return null;
    const pluginDir = path.join(await this.getPluginsDirectory(), pluginId);
    const resolved = path.resolve(pluginDir, assetRelPath);
    if (!isInsideDirectory(path.resolve(pluginDir), resolved)) {
      return null;
    }
    try {
      const s = await fs.stat(resolved);
      if (s.isFile()) {
        return resolved;
      }
    } catch {
      return null;
    }
    return null;
  }

  /** Validate a manifest's declared contract before importing its module. */
  private assertManifestCompatible(manifest: PluginManifest): void {
    const version = manifest.apiVersion ?? 0;
    if (!(SUPPORTED_API_VERSIONS as readonly number[]).includes(version)) {
      throw new PluginApiVersionError(manifest.id, PLUGIN_API_VERSION, version);
    }
    if (manifest.trust !== undefined && manifest.trust !== "trusted") {
      throw new PluginTrustError(manifest.id, manifest.trust);
    }
    this.assertClientCommands(manifest);
  }

  /**
   * Fail closed on the native-command capability: a plugin that declares
   * `system:command` must ship a non-empty, bare-name `client.commands`
   * allowlist. The desktop host enforces the same allowlist at run time; this
   * rejects a malformed manifest before its module is imported.
   */
  private assertClientCommands(manifest: PluginManifest): void {
    const capabilities = manifest.client?.capabilities ?? [];
    if (!capabilities.includes("system:command")) return;
    const commands = manifest.client?.commands;
    if (!Array.isArray(commands) || commands.length === 0) {
      throw new Error(
        `plugin '${manifest.id}' declares 'system:command' but has no client.commands allowlist`,
      );
    }
    for (const command of commands) {
      if (typeof command !== "string" || command.trim().length === 0) {
        throw new Error(
          `plugin '${manifest.id}' has an invalid client.commands entry`,
        );
      }
      if (command.includes("/") || command.includes("\\")) {
        throw new Error(
          `plugin '${manifest.id}' client.commands must be bare executable names`,
        );
      }
    }
  }

  private assertPluginCompatible(plugin: ServerPlugin): void {
    const { id, apiVersion, trust } = plugin.metadata;
    const version = apiVersion ?? 0;
    // Every plugin must declare the contract version it was built against;
    // omitting it previously bypassed the compatibility gate entirely.
    if (!(SUPPORTED_API_VERSIONS as readonly number[]).includes(version)) {
      throw new PluginApiVersionError(id, PLUGIN_API_VERSION, version);
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

  /** Deletes every map entry whose value is owned by plugin `id`. */
  private purgeOwned<V extends { pluginId: string }>(
    map: Map<string, V>,
    id: string,
  ): void {
    for (const [key, entry] of map) {
      if (entry.pluginId === id) {
        map.delete(key);
      }
    }
  }

  /** Drop a plugin's routes, sockets and event subscriptions. */
  private releasePluginResources(id: string): void {
    this.routes.delete(id);
    this.purgeOwned(this.webSockets, id);
    for (const [channel, pluginId] of this.publicChannels) {
      if (pluginId === id) {
        this.publicChannels.delete(channel);
      }
    }
    this.purgeOwned(this.metadataProviders, id);
    this.purgeOwned(this.cloudSaveResolvers, id);
    this.purgeOwned(this.paymentGateways, id);
    this.purgeOwned(this.authProviders, id);
    this.purgeOwned(this.depotProviders, id);
    for (const [key, entry] of this.scheduledTasks) {
      if (entry.pluginId === id) {
        clearInterval(entry.timer);
        this.scheduledTasks.delete(key);
      }
    }
    this.subscriptionAuthorizers.delete(id);
    const subscriptions = this.pluginEventSubscriptions.get(id) ?? [];
    for (const off of subscriptions) {
      off();
    }
    this.pluginEventSubscriptions.delete(id);
    this.storageInstances.delete(id);
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
   * Install (or update) a signed plugin bundle from its manifest and entry source
   * or multi-file payload, verifying checksums and signatures before loading.
   */
  async installBundle(
    manifest: PluginManifest,
    entryOrFiles: string | Record<string, string>,
  ): Promise<void> {
    if (!manifest.id || !manifest.name || !manifest.version) {
      throw new Error("manifest requires id, name and version");
    }
    if (!isValidPluginId(manifest.id)) {
      throw new Error("invalid plugin id");
    }

    const pluginsDir = await this.getPluginsDirectory();
    const bundleDir = path.join(pluginsDir, manifest.id);
    await fs.mkdir(bundleDir, { recursive: true });

    if (typeof entryOrFiles === "string") {
      const bytes = Buffer.from(entryOrFiles, "base64");
      const digest = this.verifyBundleBytes(bytes, manifest);
      (await this.getRegistry()).check(manifest, digest);

      const entryRel = manifest.entry || "index.js";
      const entryPath = path.resolve(bundleDir, entryRel);
      if (
        path.isAbsolute(entryRel) ||
        !isInsideDirectory(path.resolve(bundleDir), entryPath)
      ) {
        throw new Error("invalid entry path");
      }

      await fs.mkdir(path.dirname(entryPath), { recursive: true });
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
    } else if (typeof entryOrFiles === "object" && entryOrFiles !== null) {
      for (const [rel, base64] of Object.entries(entryOrFiles)) {
        const resolved = path.resolve(bundleDir, rel);
        if (
          path.isAbsolute(rel) ||
          !isInsideDirectory(path.resolve(bundleDir), resolved)
        ) {
          throw new Error(`invalid bundle file path '${rel}'`);
        }
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, Buffer.from(base64, "base64"));
      }

      await fs.writeFile(
        path.join(bundleDir, "drop-plugin.json"),
        JSON.stringify(manifest, null, 2),
      );

      await this.loadExternalPluginFromDir(bundleDir, manifest);
    } else {
      throw new Error(
        "invalid bundle payload: expected base64 entry or files map",
      );
    }
  }

  /**
   * Download, verify and install a plugin bundle from a remote URL.
   */
  async installFromUrl(url: string): Promise<void> {
    if (!url || typeof url !== "string") {
      throw new Error("Invalid plugin download URL");
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `Unsupported protocol in URL '${url}': only http and https are allowed`,
      );
    }

    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Drop-Plugin-Installer/1.0" },
    });
    if (!res.ok) {
      throw new Error(
        `Failed to download plugin from '${url}': HTTP ${res.status} ${res.statusText}`,
      );
    }

    const text = await res.text();
    let bundle: {
      manifest?: PluginManifest;
      entry?: string;
      files?: Record<string, string>;
      format?: string;
    };
    try {
      bundle = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Downloaded bundle from '${url}' is not valid JSON: ${err}`,
      );
    }

    if (!bundle?.manifest || (!bundle.entry && !bundle.files)) {
      throw new Error(
        `Downloaded bundle from '${url}' missing required manifest or file payload`,
      );
    }

    const payload = bundle.files ?? bundle.entry!;
    await this.installBundle(bundle.manifest, payload);
  }

  /**
   * Check installed plugins against configured registry for available updates.
   */
  async checkForUpdates(): Promise<
    Array<{
      id: string;
      currentVersion: string;
      latestVersion: string;
      hasUpdate: boolean;
      downloadUrl?: string;
    }>
  > {
    const registry = await this.getRegistry();
    if (!registry.enabled) {
      return [];
    }

    const results: Array<{
      id: string;
      currentVersion: string;
      latestVersion: string;
      hasUpdate: boolean;
      downloadUrl?: string;
    }> = [];

    for (const plugin of this.listPlugins()) {
      if (plugin.builtin) continue;
      const entry = registry.getEntry(plugin.id);
      if (!entry?.version) continue;

      const hasUpdate = entry.version !== plugin.version;
      results.push({
        id: plugin.id,
        currentVersion: plugin.version,
        latestVersion: entry.version,
        hasUpdate,
        downloadUrl: entry.downloadUrl ?? entry.url,
      });
    }

    return results;
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

  isPublicChannel(channel: string): boolean {
    return this.publicChannels.has(channel);
  }

  publicWebSocketChannels(): string[] {
    return Array.from(this.publicChannels.keys());
  }

  getMetadataProviders(): MetadataProvider[] {
    return Array.from(this.metadataProviders.values()).map((e) => e.provider);
  }

  getMetadataProvider(id: string): MetadataProvider | undefined {
    return this.metadataProviders.get(id)?.provider;
  }

  getCloudSaveResolvers(): CloudSavePathResolver[] {
    return Array.from(this.cloudSaveResolvers.values()).map((e) => e.resolver);
  }

  getCloudSaveResolver(id: string): CloudSavePathResolver | undefined {
    return this.cloudSaveResolvers.get(id)?.resolver;
  }

  getPaymentGateways(): PaymentGateway[] {
    return Array.from(this.paymentGateways.values()).map((e) => e.gateway);
  }

  getPaymentGateway(id: string): PaymentGateway | undefined {
    return this.paymentGateways.get(id)?.gateway;
  }

  getAuthProviders(): AuthProvider[] {
    return Array.from(this.authProviders.values()).map((e) => e.provider);
  }

  getAuthProvider(id: string): AuthProvider | undefined {
    return this.authProviders.get(id)?.provider;
  }

  getDepotProviders(): DepotStorageProvider[] {
    return Array.from(this.depotProviders.values()).map((e) => e.provider);
  }

  getDepotProvider(id: string): DepotStorageProvider | undefined {
    return this.depotProviders.get(id)?.provider;
  }

  /** Declarative settings schema for a loaded plugin, if declared. */
  getSettingsSchema(id: string): PluginSettingsSchema | undefined {
    const plugin = this.plugins.get(id)?.plugin;
    return normalizeSettingsSchema(plugin?.metadata.settingsSchema);
  }

  /** Effective settings values (including defaults) for a loaded plugin. */
  async getPluginSettings(id: string): Promise<Record<string, unknown>> {
    if (!this.plugins.has(id)) {
      throw createError({
        statusCode: 404,
        statusMessage: `Plugin '${id}' not found`,
      });
    }
    return await this.readSettingsFor(id, this.getSettingsSchema(id));
  }

  /** Settings view with `password` values redacted, for API consumers. */
  async getPluginSettingsView(id: string): Promise<{
    schema: PluginSettingsSchema;
    values: Record<string, unknown>;
    secrets: Record<string, boolean>;
  } | null> {
    const schema = this.getSettingsSchema(id);
    if (!schema) return null;
    const values = await this.readSettingsFor(id, schema);
    const redacted = redactSettingsValues(schema, values);
    return { schema, values: redacted.values, secrets: redacted.secrets };
  }

  /** Validate + persist a partial settings update. Returns the redacted view. */
  async setPluginSettings(id: string, submitted: unknown) {
    if (!this.plugins.has(id)) {
      throw createError({
        statusCode: 404,
        statusMessage: `Plugin '${id}' not found`,
      });
    }
    const schema = this.getSettingsSchema(id);
    if (!schema) {
      throw createError({
        statusCode: 400,
        statusMessage: `Plugin '${id}' does not declare a settingsSchema`,
      });
    }
    const current = await this.readSettingsFor(id, schema);
    const merge = mergeSettingsPayload(schema, current, submitted);
    const validation = validateSettingsValues(schema, merge.input);
    const errors = [...merge.errors, ...validation.errors];
    if (errors.length > 0) {
      throw createError({
        statusCode: 400,
        statusMessage: errors.join("; "),
      });
    }
    const storage = await this.getStorageInstance(id);
    await storage.set(PLUGIN_SETTINGS_STORAGE_KEY, validation.values);
    return await this.getPluginSettingsView(id);
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

    const body = await readBody(event).catch(() => undefined);

    const context: RouteHandlerContext = {
      params: matchedParams,
      query: getQuery(event),
      body,
      readJson: async function <T = unknown>(): Promise<T> {
        return body as T;
      },
      userId,
      userAcls,
    };

    return await matchedRoute.handler(event, context);
  }
}

export const pluginManager = new PluginManager();
export default pluginManager;
