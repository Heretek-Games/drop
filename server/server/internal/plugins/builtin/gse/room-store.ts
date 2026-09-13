import { randomUUID } from "node:crypto";
import type { CompatRegistry } from "./compat";
import type { RoomPersistence } from "./persistence";
import type {
  DiscoverableRoom,
  EmulatorBinding,
  MeshBackend,
  MeshCredential,
  Room,
} from "./types";
import { toDiscoverable } from "./types";

/** Room lifetime. */
export const ROOM_TTL_MS = 4 * 60 * 60 * 1000;
/** Host renews its lease this often. */
export const HOST_HEARTBEAT_MS = 15_000;
/** Host lease expires after this much silence. */
export const HOST_LEASE_MS = 45_000;
/** Re-issue a credential when this close to expiry. */
export const CREDENTIAL_ROTATION_WINDOW_MS = 10 * 60 * 1000;
/** Per-host concurrent room cap. */
export const MAX_ROOMS_PER_HOST = 5;
/** Global room cap. */
export const MAX_ROOMS = 200;

export interface CreateRoomInput {
  gameId: string;
  versionId: string;
  appId?: number | undefined;
  emulator: EmulatorBinding;
  hostUserId: string;
}

/**
 * Room registry with distributed-ish host leases, backed by a
 * {@link RoomPersistence} (Postgres in production, plugin storage in tests).
 *
 * Host migration is first-writer-wins: any member may claim an expired lease
 * on join/heartbeat.
 */
export class RoomStore {
  constructor(
    private readonly persistence: RoomPersistence,
    private readonly backend: MeshBackend,
    private readonly now: () => number = Date.now,
    private readonly compat?: CompatRegistry,
  ) {}

  /** Drop expired rooms and tear their mesh down. Returns count removed. */
  async pruneExpired(): Promise<number> {
    const rooms = await this.persistence.listRooms();
    const now = this.now();
    const expired = rooms.filter((room) => room.expiresAt <= now);
    for (const room of expired) {
      await this.persistence.deleteRoom(room.id);
      await this.persistence.deleteCredentials(room.id);
      await this.backend.teardown(room.id, room.mesh);
    }
    return expired.length;
  }

  async create(input: CreateRoomInput): Promise<Room> {
    const rooms = await this.persistence.listRooms();
    const now = this.now();

    const hostRooms = rooms.filter(
      (room) => room.hostUserId === input.hostUserId && room.expiresAt > now,
    );
    if (hostRooms.length >= MAX_ROOMS_PER_HOST) {
      throw new Error("room limit reached for this host");
    }
    if (rooms.length >= MAX_ROOMS) {
      throw new Error("global room limit reached");
    }
    if (this.compat?.isBlocked(input.gameId, input.appId)) {
      throw new Error("game is known-incompatible with GSE");
    }

    const roomId = randomUUID();
    const expiresAt = now + ROOM_TTL_MS;
    const mesh = await this.backend.provision(roomId, expiresAt);

    const room: Room = {
      id: roomId,
      gameId: input.gameId,
      versionId: input.versionId,
      appId: input.appId,
      emulator: input.emulator,
      hostUserId: input.hostUserId,
      hostHeartbeatAt: now,
      members: [{ userId: input.hostUserId, joinedAt: now }],
      mesh,
      createdAt: now,
      expiresAt,
    };
    await this.persistence.saveRoom(room);
    return room;
  }

  async get(roomId: string): Promise<Room | undefined> {
    const room = await this.persistence.getRoom(roomId);
    if (!room || room.expiresAt <= this.now()) return undefined;
    return room;
  }

  async list(gameId?: string): Promise<DiscoverableRoom[]> {
    const rooms = await this.persistence.listRooms();
    const now = this.now();
    return rooms
      .filter((room) => room.expiresAt > now)
      .filter((room) => !gameId || room.gameId === gameId)
      .map(toDiscoverable);
  }

  private claimExpiredLease(room: Room): void {
    const now = this.now();
    if (now - room.hostHeartbeatAt <= HOST_LEASE_MS) return;
    const candidates = room.members
      .filter((member) => member.userId !== room.hostUserId)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    const successor = candidates[0] ?? room.members[0];
    if (successor) {
      room.hostUserId = successor.userId;
      room.hostHeartbeatAt = now;
    }
  }

  async join(roomId: string, userId: string): Promise<Room> {
    const room = await this.persistence.getRoom(roomId);
    if (!room || room.expiresAt <= this.now()) {
      throw new Error("room not found");
    }
    if (!room.members.some((member) => member.userId === userId)) {
      room.members.push({ userId, joinedAt: this.now() });
    }
    this.claimExpiredLease(room);
    await this.persistence.saveRoom(room);
    return room;
  }

  /**
   * Authorize a member's mesh node after it joins and record its address.
   * Called when the client reports its backend member id.
   */
  async registerMember(
    roomId: string,
    userId: string,
    memberId: string,
  ): Promise<Room> {
    const room = await this.persistence.getRoom(roomId);
    if (!room || room.expiresAt <= this.now()) {
      throw new Error("room not found");
    }
    const member = room.members.find((entry) => entry.userId === userId);
    if (!member) {
      throw new Error("not a room member");
    }

    if (this.backend.authorizeMember) {
      const address = await this.backend.authorizeMember(
        roomId,
        userId,
        memberId,
      );
      if (address) {
        member.meshAddress = address;
        await this.persistence.saveRoom(room);
      }
    }
    return room;
  }

  async heartbeat(roomId: string, userId: string): Promise<Room> {
    const room = await this.persistence.getRoom(roomId);
    if (!room || room.expiresAt <= this.now()) {
      throw new Error("room not found");
    }
    this.claimExpiredLease(room);
    if (room.hostUserId === userId) {
      room.hostHeartbeatAt = this.now();
    }
    await this.persistence.saveRoom(room);
    return room;
  }

  async leave(
    roomId: string,
    userId: string,
  ): Promise<{ closed: boolean; room?: Room }> {
    const room = await this.persistence.getRoom(roomId);
    if (!room) return { closed: false };

    if (room.hostUserId === userId) {
      await this.persistence.deleteRoom(roomId);
      await this.persistence.deleteCredentials(roomId);
      await this.backend.teardown(roomId, room.mesh);
      return { closed: true };
    }

    room.members = room.members.filter((member) => member.userId !== userId);
    await this.backend.revokeMember(roomId, userId);
    await this.persistence.saveRoom(room);
    return { closed: false, room };
  }

  /** Issue (or return the existing) server-side credential for a member. */
  async credential(roomId: string, userId: string): Promise<MeshCredential> {
    const room = await this.persistence.getRoom(roomId);
    if (!room || room.expiresAt <= this.now()) {
      throw new Error("room not found");
    }
    const member = room.members.find((entry) => entry.userId === userId);
    if (!member) {
      throw new Error("not a room member");
    }

    const roomCredentials = await this.persistence.getCredentials(roomId);
    const existing = roomCredentials[userId];
    // Return a cached credential unless it is close to expiry (rotate).
    if (
      existing &&
      existing.expiresAt - this.now() > CREDENTIAL_ROTATION_WINDOW_MS
    ) {
      return existing;
    }

    const issued = await this.backend.issueCredential(
      roomId,
      userId,
      room.mesh,
    );
    const credential: MeshCredential = {
      roomId,
      userId,
      secret: issued.secret,
      address: issued.address,
      issuedAt: this.now(),
      expiresAt: room.expiresAt,
    };

    // Record the assigned mesh address so peers see it in the room view.
    if (issued.address) {
      member.meshAddress = issued.address;
      await this.persistence.saveRoom(room);
    }

    await this.persistence.saveCredential(roomId, credential);
    return credential;
  }
}
