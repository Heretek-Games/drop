/**
 * Core plugin API contracts shared by the Drop server and desktop client.
 *
 * This package is intentionally type-only: every export is a type or an
 * interface, so consumers must use `import type`/`export type`. Keeping it
 * free of runtime values avoids bundler and module-resolution issues in
 * Nuxt/Nitro, where the package is consumed purely for type checking.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "ALL";

export type PluginTarget = "server" | "client";

export type PluginCategory = "generic" | "metadata" | "storage" | "multiplayer";

export type ServerCapability =
  | "routes"
  | "storage"
  | "websocket"
  | "events"
  | "network"
  | "metadata:provider"
  | "cloudsave:provider"
  | "commerce:payment";

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
  | "system:command"
  | "metadata:provider"
  | "cloudsave:provider"
  | "client:library-scan";

export type PluginCapability = ServerCapability | ClientCapability;

/**
 * Trust tier. Only `"trusted"` is supported today: plugins run in-process with
 * the server or client's own privileges. `"sandboxed"` is reserved for a future
 * isolated runtime and must be rejected until that runtime exists.
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
   * Signature scheme marker. Bundles signed by `@drop-oss/plugin-cli` >= 0.6.0
   * carry `2`, meaning `signature` covers the file aggregate plus the canonical
   * manifest. Absent on legacy bundles, whose signature covers the file
   * aggregate or entry checksum only.
   */
  signatureVersion?: number;
  /**
   * HMAC-SHA256 (hex) of the signature payload, keyed by
   * `DROP_PLUGIN_SIGNING_KEY`. Set `DROP_PLUGIN_REQUIRE_SIGNATURE=true` to
   * reject unsigned bundles.
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

/**
 * Logger contract exposed to plugins. Matches the matching interface in
 * `@drop-oss/plugin-sdk` so plugin code can be typed against either package.
 */
export interface PluginLogger {
  info(msg: string, ...args: any[]): void;
  warn(msg: string, ...args: any[]): void;
  error(msg: string, ...args: any[]): void;
  debug(msg: string, ...args: any[]): void;
}

// ==========================================
// Payment Gateway SPI (#21)
// ==========================================

export interface PaymentIntentRequest {
  orderId: string;
  amount: number; // minor units (e.g. cents)
  currency: string;
  customerEmail?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentIntentResult {
  intentId: string;
  clientSecret?: string;
  checkoutUrl?: string;
  status: "pending" | "succeeded" | "failed";
}

export interface PaymentWebhookResult {
  orderId: string;
  status: "succeeded" | "failed" | "refunded";
  transactionId: string;
  payload?: Record<string, unknown>;
}

export interface PaymentGateway {
  id: string;
  name: string;
  createPaymentIntent(req: PaymentIntentRequest): Promise<PaymentIntentResult>;
  handleWebhook(
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<PaymentWebhookResult>;
}
