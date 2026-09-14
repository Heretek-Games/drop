import type { H3Event } from "h3";
import type { Logger } from "pino";

/**
 * Current plugin API version. Bump this when `PluginContext` or the manifest
 * contract changes incompatibly. Plugins declare the version they were built
 * against in `metadata.apiVersion`; mismatches are rejected at registration.
 */
/**
 * Current plugin API version. Bump this when `PluginContext` or the manifest
 * contract changes incompatibly. Plugins declare the version they were built
 * against in `metadata.apiVersion`; mismatches are rejected at registration.
 */
export const PLUGIN_API_VERSION = 2;
export const SUPPORTED_API_VERSIONS = [1, 2] as const;

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "ALL";

export type PluginTarget = "server" | "client";

export type PluginCategory = "generic" | "metadata" | "storage" | "multiplayer";

export type ServerCapability =
  "routes" | "storage" | "websocket" | "events" | "network";

export type ClientCapability =
  | "ui:slot"
  | "ui:play-action"
  | "ui:context-menu"
  | "ui:sidebar"
  | "ui:topbar"
  | "game:launch-hook"
  | "game:fs"
  | "game:scan"
  | "client:storage"
  | "client:ws"
  | "system:sidecar"
  | "system:command";

export type PluginCapability = ServerCapability | ClientCapability;

/**
 * Trust tier. Only `"trusted"` is supported today: plugins run in-process with
 * the server's own privileges. `"sandboxed"` is reserved for a future isolated
 * runtime (see docs/implementation/drop-gse.md, M4/P6) and must be rejected
 * until that runtime exists.
 */
export type PluginTrust = "trusted" | "sandboxed";

export type PluginStatus = "active" | "disabled" | "error" | "registered";

export interface PluginMetadata {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  builtin?: boolean;
  /** Plugin API version the plugin was built against. */
  apiVersion?: number;
  /** Trust tier. Defaults to "trusted". */
  trust?: PluginTrust;
  /** Declared storage schema version; drives `migrateStorage`. */
  storageVersion?: number;
  category?: PluginCategory;
  targets?: PluginTarget[];
  capabilities?: PluginCapability[];
  enabled?: boolean;
}

export interface PluginManifest extends PluginMetadata {
  entry?: string;
  /** SHA-256 of the entry file, hex. Verified before the bundle is imported. */
  checksum?: string;
  /**
   * SHA-256 of every file the bundle may import, keyed by path relative to the
   * bundle directory. Required for multi-file bundles so relative imports are
   * verified too. When present with `DROP_PLUGIN_SIGNING_KEY`, `signature`
   * covers the aggregate bundle digest rather than only the entry file.
   */
  files?: Record<string, string>;
  /**
   * HMAC-SHA256 (hex) of `checksum`, keyed by `DROP_PLUGIN_SIGNING_KEY`.
   * Set `DROP_PLUGIN_REQUIRE_SIGNATURE=true` to reject unsigned bundles.
   */
  signature?: string;

  server?: {
    entry: string;
    capabilities: ServerCapability[];
    storageVersion?: number;
  };
  client?: {
    entry: string;
    css?: string;
    capabilities: ClientCapability[];
    slots?: Array<{ slot: string; component: string }>;
    /**
     * Bare executable names the client plugin may run via `ctx.system.run`
     * (requires the `system:command` capability). Enforced by the desktop host.
     */
    commands?: string[];
  };
}

export interface PluginStateRecord {
  enabled: boolean;
  updatedAt: number;
}

export interface RouteHandlerContext {
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  userId?: string;
  userAcls?: string[];
}

export type RouteHandler = (
  event: H3Event,
  context: RouteHandlerContext,
) => unknown;

export interface PluginStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(): Promise<string[]>;
  /** Declared/recorded schema version for `migrateStorage`. */
  getSchemaVersion(): Promise<number>;
  setSchemaVersion(version: number): Promise<void>;
}

/** Caller identity + reply sink for a plugin WebSocket message. */
export interface WebSocketContext {
  userId?: string;
  userAcls?: string[];
  send: (data: unknown) => void;
}

/** Caller identity available when authorizing a channel subscription. */
export interface SubscriptionContext {
  userId: string | undefined;
  userAcls: string[] | undefined;
}

/**
 * Authorize a client subscription to a channel. Returning `false` denies the
 * subscription; a channel with no matching authorizer is allowed (subject to
 * the gateway's authentication requirement).
 */
export type SubscriptionAuthorizer = (
  channel: string,
  context: SubscriptionContext,
) => Promise<boolean> | boolean;

export type WebSocketHandler = (
  message: unknown,
  context: WebSocketContext,
) => Promise<void> | void;

export interface WebSocketOptions {
  /**
   * If true, clients can subscribe to and receive broadcasts on this channel
   * without an authenticated user session (e.g. public game lobbies, server status).
   * Defaults to false.
   */
  public?: boolean;
}

export interface PluginContext {
  id: string;
  logger: Logger;
  storage: PluginStorage;
  registerRoute(
    method: HttpMethod,
    pattern: string,
    handler: RouteHandler,
  ): void;
  broadcast(channel: string, event: unknown): void;
  subscribe(channel: string, listener: (event: unknown) => void): () => void;
  /**
   * Handle client messages on a WebSocket channel. Requires the `websocket`
   * capability. Channel names are global; a channel may only be claimed once.
   */
  registerWebSocket(
    channel: string,
    handler: WebSocketHandler,
    options?: WebSocketOptions,
  ): void;
  /**
   * Mark a channel as publicly readable without authentication.
   * Requires the `websocket` capability.
   */
  registerPublicWebSocketChannel(channel: string): void;
  /**
   * Gate client subscriptions to channels matching `matches`. Requires the
   * `websocket` capability. Channels with no matching authorizer stay open to
   * authenticated peers.
   */
  registerSubscriptionAuthorizer(
    matches: (channel: string) => boolean,
    authorize: SubscriptionAuthorizer,
  ): void;
  /** Network egress. Requires the `network` capability. */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface ServerPlugin {
  metadata: PluginMetadata;
  init(ctx: PluginContext): Promise<void> | void;
  teardown?(): Promise<void> | void;
  /**
   * Apply storage migrations when the recorded schema version is older than
   * `metadata.storageVersion`. `from` is exclusive, `to` inclusive.
   */
  migrateStorage?(
    from: number,
    to: number,
    storage: PluginStorage,
  ): Promise<void>;
}
