import type { H3Event } from "h3";
import type { Logger } from "pino";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "ALL";

export type PluginCapability =
  "routes" | "storage" | "websocket" | "events" | "network";

export type PluginStatus = "active" | "disabled" | "error" | "registered";

export interface PluginMetadata {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  builtin?: boolean;
  capabilities?: PluginCapability[];
  enabled?: boolean;
}

export interface PluginManifest extends PluginMetadata {
  entry?: string;
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
) => Promise<unknown> | unknown;

export interface PluginStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(): Promise<string[]>;
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
}

export interface ServerPlugin {
  metadata: PluginMetadata;
  init(ctx: PluginContext): Promise<void> | void;
  teardown?(): Promise<void> | void;
}
