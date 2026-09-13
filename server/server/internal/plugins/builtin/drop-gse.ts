import { createError, readBody } from "h3";
import { PLUGIN_API_VERSION } from "../types";
import type { PluginContext, PluginMetadata, ServerPlugin } from "../types";
import { CompatRegistry, compatFromEnv } from "./gse/compat";
import { InMemoryMeshBackend, ZeroTierBackend } from "./gse/mesh";
import { RoomStore } from "./gse/room-store";
import { toDiscoverable } from "./gse/types";
import type { EmulatorBinding, MeshBackend } from "./gse/types";

export type {
  DiscoverableRoom,
  EmulatorBinding,
  MeshBackend,
  MeshCredential,
  PublicMeshInfo,
  Room,
  RoomMember,
} from "./gse/types";

const DEFAULT_EMULATOR: EmulatorBinding = {
  flavor: "gbe_fork",
  release: "latest",
  releaseDigest: "sha256-default",
};

const PRUNE_INTERVAL_MS = 60_000;

/**
 * Drop GSE multiplayer room coordinator.
 *
 * Rooms are durable (plugin storage) and mesh-backed by a pluggable
 * `MeshBackend`: ZeroTier when `GSE_ZEROTIER_URL`/`GSE_ZEROTIER_TOKEN`/
 * `GSE_ZEROTIER_NODE` are configured, otherwise an in-memory backend.
 */
export class DropGseServerPlugin implements ServerPlugin {
  metadata: PluginMetadata = {
    id: "drop-gse",
    name: "Drop GSE Multiplayer",
    version: "0.2.0",
    description:
      "Peer-to-peer multiplayer rooms over virtual mesh networks using Goldberg Steam emulator",
    author: "Heretek Games",
    builtin: true,
    apiVersion: PLUGIN_API_VERSION,
    trust: "trusted",
    storageVersion: 1,
    capabilities: ["routes", "events", "storage", "network", "websocket"],
    enabled: true,
  };

  private store!: RoomStore;
  private ctx!: PluginContext;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  private resolveBackend(): MeshBackend {
    const baseUrl = process.env.GSE_ZEROTIER_URL;
    const authToken = process.env.GSE_ZEROTIER_TOKEN;
    const controllerNodeId = process.env.GSE_ZEROTIER_NODE;
    if (baseUrl && authToken && controllerNodeId) {
      return new ZeroTierBackend({ baseUrl, authToken, controllerNodeId });
    }
    return new InMemoryMeshBackend();
  }

  init(ctx: PluginContext): void {
    this.ctx = ctx;
    const compat = new CompatRegistry(compatFromEnv());
    this.store = new RoomStore(
      ctx.storage,
      this.resolveBackend(),
      Date.now,
      compat,
    );

    // B7: periodic TTL sweep. unref so tests/CLI don't hang on the timer.
    this.pruneTimer = setInterval(() => {
      this.store.pruneExpired().catch(() => {});
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();

    // WebSocket: host lease renewal / liveness over the plugin WS gateway.
    ctx.registerWebSocket("gse:heartbeat", async (message, wsCtx) => {
      const payload = (message ?? {}) as { roomId?: string };
      if (!payload.roomId || !wsCtx.userId) {
        wsCtx.send({ ok: false, error: "roomId and authentication required" });
        return;
      }
      try {
        const room = await this.store.heartbeat(payload.roomId, wsCtx.userId);
        wsCtx.send({ ok: true, hostUserId: room.hostUserId });
      } catch {
        wsCtx.send({ ok: false, error: "room not found" });
      }
    });

    // Route: GET /compat — known-incompatible games/AppIDs.
    ctx.registerRoute("GET", "/compat", () => compat.info());

    // Route: GET /rooms
    ctx.registerRoute("GET", "/rooms", async (_event, context) => {
      await this.store.pruneExpired();
      const gameId =
        typeof context.query.gameId === "string"
          ? context.query.gameId
          : undefined;
      return { rooms: await this.store.list(gameId) };
    });

    // Route: POST /rooms
    ctx.registerRoute("POST", "/rooms", async (event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required to host a room",
        });
      }

      const body = await readBody<{
        gameId?: string;
        versionId?: string;
        appId?: number;
        emulator?: EmulatorBinding;
      }>(event);

      if (!body?.gameId || !body?.versionId) {
        throw createError({
          statusCode: 400,
          statusMessage: "gameId and versionId are required",
        });
      }

      try {
        const room = await this.store.create({
          gameId: body.gameId,
          versionId: body.versionId,
          appId: body.appId,
          emulator: body.emulator ?? DEFAULT_EMULATOR,
          hostUserId: context.userId,
        });
        ctx.broadcast("gse:rooms", {
          type: "room_created",
          room: toDiscoverable(room),
        });
        ctx.logger.info(
          `Multiplayer room ${room.id} created for game ${body.gameId} by user ${context.userId}`,
        );
        return { room };
      } catch (err) {
        const message = String(err);
        throw createError({
          statusCode: message.includes("known-incompatible") ? 409 : 429,
          statusMessage: message,
        });
      }
    });

    // Route: GET /rooms/:id — full room for members, discovery view otherwise.
    ctx.registerRoute("GET", "/rooms/:id", async (_event, context) => {
      const room = await this.store.get(context.params.id);
      if (!room) {
        throw createError({ statusCode: 404, statusMessage: "Room not found" });
      }
      const isMember =
        !!context.userId &&
        room.members.some((member) => member.userId === context.userId);
      if (isMember) return { room };
      const { toDiscoverable } = await import("./gse/types");
      return { room: toDiscoverable(room) };
    });

    // Route: POST /rooms/:id/join
    ctx.registerRoute("POST", "/rooms/:id/join", async (_event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required to join a room",
        });
      }

      let room;
      try {
        room = await this.store.join(context.params.id, context.userId);
      } catch {
        throw createError({ statusCode: 404, statusMessage: "Room not found" });
      }

      ctx.broadcast(`gse:room:${room.id}`, {
        type: "member_joined",
        roomId: room.id,
        userId: context.userId,
      });
      ctx.broadcast("gse:rooms", {
        type: "room_updated",
        room: toDiscoverable(room),
      });
      return { room };
    });

    // Route: POST /rooms/:id/heartbeat — host lease renewal / migration.
    ctx.registerRoute(
      "POST",
      "/rooms/:id/heartbeat",
      async (_event, context) => {
        if (!context.userId) {
          throw createError({
            statusCode: 401,
            statusMessage: "Authentication required",
          });
        }
        try {
          const room = await this.store.heartbeat(
            context.params.id,
            context.userId,
          );
          return { ok: true, hostUserId: room.hostUserId };
        } catch {
          throw createError({
            statusCode: 404,
            statusMessage: "Room not found",
          });
        }
      },
    );

    // Route: POST /rooms/:id/member — report this node's mesh member id so the
    // backend can authorize it and assign an address.
    ctx.registerRoute("POST", "/rooms/:id/member", async (event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required",
        });
      }
      const body = await readBody<{ memberId?: string }>(event);
      if (!body?.memberId) {
        throw createError({
          statusCode: 400,
          statusMessage: "memberId is required",
        });
      }
      try {
        const room = await this.store.registerMember(
          context.params.id,
          context.userId,
          body.memberId,
        );
        ctx.broadcast("gse:rooms", {
          type: "room_updated",
          room: toDiscoverable(room),
        });
        return { room };
      } catch (err) {
        const message = String(err);
        throw createError({
          statusCode: message.includes("not a room member") ? 403 : 404,
          statusMessage: message,
        });
      }
    });

    // Route: DELETE /rooms/:id
    ctx.registerRoute("DELETE", "/rooms/:id", async (_event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required",
        });
      }

      const { closed, room } = await this.store.leave(
        context.params.id,
        context.userId,
      );
      if (closed) {
        ctx.broadcast(`gse:room:${context.params.id}`, {
          type: "room_closed",
          roomId: context.params.id,
        });
        ctx.broadcast("gse:rooms", {
          type: "room_closed",
          roomId: context.params.id,
        });
        return { success: true, closed: true };
      }

      ctx.broadcast(`gse:room:${context.params.id}`, {
        type: "member_left",
        roomId: context.params.id,
        userId: context.userId,
      });
      if (room) {
        ctx.broadcast("gse:rooms", { type: "room_updated", room });
      }
      return { success: true, closed: false };
    });

    // Route: POST /rooms/:id/credential — membership-gated mesh credential.
    ctx.registerRoute(
      "POST",
      "/rooms/:id/credential",
      async (_event, context) => {
        if (!context.userId) {
          throw createError({
            statusCode: 401,
            statusMessage: "Authentication required",
          });
        }

        let credential;
        try {
          credential = await this.store.credential(
            context.params.id,
            context.userId,
          );
        } catch (err) {
          const message = String(err);
          if (message.includes("not a room member")) {
            throw createError({ statusCode: 403, statusMessage: message });
          }
          throw createError({
            statusCode: 404,
            statusMessage: "Room not found",
          });
        }

        const room = await this.store.get(context.params.id);
        // Notify members a credential is available; the secret itself is only
        // ever returned over this authenticated, membership-checked call.
        ctx.broadcast(`gse:room:${context.params.id}`, {
          type: "credential_available",
          roomId: context.params.id,
          userId: context.userId,
          expiresAt: credential.expiresAt,
        });
        return {
          credential: {
            mesh: room?.mesh,
            secret: credential.secret,
            expiresAt: credential.expiresAt,
          },
        };
      },
    );
  }

  teardown(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }
}

export const dropGseServerPlugin = new DropGseServerPlugin();
