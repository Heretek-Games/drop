import { readBody, createError } from "h3";
import { v4 as uuidv4 } from "uuid";
import type { PluginContext, ServerPlugin, PluginMetadata } from "../types";

export interface EmulatorBinding {
  flavor: "gbe_fork" | "gse_fork";
  release: string;
  releaseDigest: string;
}

export type PublicMeshInfo =
  | { backend: "tailscale"; aclTag: string; expiresAt: number }
  | { backend: "zerotier"; cidr: string; networkId: string; expiresAt: number };

export interface RoomMember {
  userId: string;
  meshAddress?: string;
  joinedAt: number;
}

export interface Room {
  id: string;
  gameId: string;
  versionId: string;
  emulator: EmulatorBinding;
  hostUserId: string;
  members: RoomMember[];
  mesh: PublicMeshInfo;
  createdAt: number;
  expiresAt: number;
}

export interface DiscoverableRoom {
  id: string;
  gameId: string;
  versionId: string;
  emulator: EmulatorBinding;
  mesh: PublicMeshInfo;
  memberCount: number;
  createdAt: number;
  expiresAt: number;
}

export class DropGseServerPlugin implements ServerPlugin {
  metadata: PluginMetadata = {
    id: "drop-gse",
    name: "Drop GSE Multiplayer",
    version: "0.1.0",
    description:
      "Peer-to-peer multiplayer rooms over virtual mesh networks using Goldberg Steam emulator",
    author: "Heretek Games",
    builtin: true,
    capabilities: ["routes", "storage", "websocket", "events"],
    enabled: true,
  };

  private rooms = new Map<string, Room>();
  private ctx!: PluginContext;

  init(ctx: PluginContext): void {
    this.ctx = ctx;

    // Route: GET /rooms
    ctx.registerRoute("GET", "/rooms", (_event, context) => {
      const gameId =
        typeof context.query.gameId === "string"
          ? context.query.gameId
          : undefined;
      const now = Date.now();

      const discoverable: DiscoverableRoom[] = [];
      for (const room of this.rooms.values()) {
        if (room.expiresAt < now) continue;
        if (gameId && room.gameId !== gameId) continue;

        discoverable.push({
          id: room.id,
          gameId: room.gameId,
          versionId: room.versionId,
          emulator: room.emulator,
          mesh: room.mesh,
          memberCount: room.members.length,
          createdAt: room.createdAt,
          expiresAt: room.expiresAt,
        });
      }

      return { rooms: discoverable };
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
        emulator?: EmulatorBinding;
        backend?: "tailscale" | "zerotier";
      }>(event);

      if (!body?.gameId || !body?.versionId) {
        throw createError({
          statusCode: 400,
          statusMessage: "gameId and versionId are required",
        });
      }

      const roomId = uuidv4();
      const now = Date.now();
      const expiresAt = now + 4 * 60 * 60 * 1000; // 4 hour TTL
      const backend = body.backend ?? "zerotier";

      const mesh: PublicMeshInfo =
        backend === "tailscale"
          ? {
              backend: "tailscale",
              aclTag: `tag:dropgse-room-${roomId}`,
              expiresAt,
            }
          : {
              backend: "zerotier",
              cidr: "10.147.20.0/24",
              networkId: `zt-${roomId.slice(0, 16)}`,
              expiresAt,
            };

      const emulator: EmulatorBinding = body.emulator ?? {
        flavor: "gbe_fork",
        release: "latest",
        releaseDigest: "sha256-default",
      };

      const room: Room = {
        id: roomId,
        gameId: body.gameId,
        versionId: body.versionId,
        emulator,
        hostUserId: context.userId,
        members: [{ userId: context.userId, joinedAt: now }],
        mesh,
        createdAt: now,
        expiresAt,
      };

      this.rooms.set(roomId, room);
      ctx.broadcast("gse:rooms", { type: "room_created", room });
      ctx.logger.info(
        `Multiplayer room ${roomId} created for game ${body.gameId} by user ${context.userId}`,
      );

      return { room };
    });

    // Route: GET /rooms/:id
    ctx.registerRoute("GET", "/rooms/:id", (_event, context) => {
      const room = this.rooms.get(context.params.id);
      if (!room) {
        throw createError({ statusCode: 404, statusMessage: "Room not found" });
      }

      return { room };
    });

    // Route: POST /rooms/:id/join
    ctx.registerRoute("POST", "/rooms/:id/join", (_event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required to join a room",
        });
      }

      const room = this.rooms.get(context.params.id);
      if (!room) {
        throw createError({ statusCode: 404, statusMessage: "Room not found" });
      }

      const existing = room.members.find((m) => m.userId === context.userId);
      if (!existing) {
        room.members.push({ userId: context.userId, joinedAt: Date.now() });
      }

      ctx.broadcast(`gse:room:${room.id}`, {
        type: "member_joined",
        roomId: room.id,
        userId: context.userId,
      });
      ctx.broadcast("gse:rooms", { type: "room_updated", room });

      return { room };
    });

    // Route: DELETE /rooms/:id
    ctx.registerRoute("DELETE", "/rooms/:id", (_event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required",
        });
      }

      const room = this.rooms.get(context.params.id);
      if (!room) {
        throw createError({ statusCode: 404, statusMessage: "Room not found" });
      }

      // If host leaves, close the room. If member leaves, remove them.
      if (room.hostUserId === context.userId) {
        this.rooms.delete(room.id);
        ctx.broadcast(`gse:room:${room.id}`, {
          type: "room_closed",
          roomId: room.id,
        });
        ctx.broadcast("gse:rooms", { type: "room_closed", roomId: room.id });
        ctx.logger.info(`Host ${context.userId} closed room ${room.id}`);
        return { success: true, closed: true };
      }

      room.members = room.members.filter((m) => m.userId !== context.userId);
      ctx.broadcast(`gse:room:${room.id}`, {
        type: "member_left",
        roomId: room.id,
        userId: context.userId,
      });
      ctx.broadcast("gse:rooms", { type: "room_updated", room });

      return { success: true, closed: false };
    });

    // Route: POST /rooms/:id/credential
    ctx.registerRoute("POST", "/rooms/:id/credential", (_event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required",
        });
      }

      const room = this.rooms.get(context.params.id);
      if (!room) {
        throw createError({ statusCode: 404, statusMessage: "Room not found" });
      }

      const isMember = room.members.some((m) => m.userId === context.userId);
      if (!isMember) {
        throw createError({
          statusCode: 403,
          statusMessage: "Must be a member of the room to request credentials",
        });
      }

      const ephemeralSecret = `gse-mesh-${room.id.slice(0, 8)}-${context.userId.slice(0, 6)}-${Date.now()}`;
      return {
        credential: {
          mesh: room.mesh,
          secret: ephemeralSecret,
          expiresAt: room.expiresAt,
        },
      };
    });
  }

  teardown(): void {
    this.rooms.clear();
  }
}

export const dropGseServerPlugin = new DropGseServerPlugin();
