import { randomUUID } from "node:crypto";
import type { PluginStorage } from "../../types";
import type {
  DiscoverableRoom,
  EmulatorBinding,
  MeshBackend,
  MeshCredential,
  Room,
  RoomMember,
} from "./types";
import { toDiscoverable } from "./types";

/** Room lifetime. */
export const ROOM_TTL_MS = 4 * 60 * 60 * 1000;
/** Host renews its lease this often. */
export const HOST_HEARTBEAT_MS = 15_000;
/** Host lease expires after this much silence. */
export const HOST_LEASE_MS = 45_000;
/** Per-host concurrent room cap. */
export const MAX_ROOMS_PER_HOST = 5;
/** Global room cap. */
export const MAX_ROOMS = 200;

const ROOMS_KEY = "rooms";
const CREDENTIALS_KEY = "credentials";

interface CredentialMap {
  [roomId: string]: { [userId: string]: MeshCredential };
}

export interface CreateRoomInput {
  gameId: string;
  versionId: string;
  emulator: EmulatorBinding;
  hostUserId: string;
}

/**
 * Durable, storage-backed room registry with distributed-ish host leases.
 *
 * All state lives in plugin storage (`rooms`, `credentials`), so it survives a
 * coordinator restart. Host migration is first-writer-wins: any member may
 * claim an expired lease on join/heartbeat.
 */
export class RoomStore {
  constructor(
    private readonly storage: PluginStorage,
    private readonly backend: MeshBackend,
    private readonly now: () => number = Date.now,
  ) {}

  private async loadRooms(): Promise<Record<string, Room>> {
    return (await this.storage.get<Record<string, Room>>(ROOMS_KEY)) ?? {};
  }

  private async saveRooms(rooms: Record<string, Room>): Promise<void> {
    await this.storage.set(ROOMS_KEY, rooms);
  }

  private async loadCredentials(): Promise<CredentialMap> {
    return (await this.storage.get<CredentialMap>(CREDENTIALS_KEY)) ?? {};
  }

  /** Drop expired rooms and tear their mesh down. Returns count removed. */
  async pruneExpired(): Promise<number> {
    const rooms = await this.loadRooms();
    const now = this.now();
    const expired = Object.entries(rooms)
      .filter(([, room]) => room.expiresAt <= now)
      .map(([id]) => id);
    for (const id of expired) {
      Reflect.deleteProperty(rooms, id);
      await this.backend.teardown(id);
    }
    if (expired.length > 0) {
      await this.saveRooms(rooms);
    }
    return expired.length;
  }

  async create(input: CreateRoomInput): Promise<Room> {
    const rooms = await this.loadRooms();
    const now = this.now();

    const hostRooms = Object.values(rooms).filter(
      (room) => room.hostUserId === input.hostUserId && room.expiresAt > now,
    );
    if (hostRooms.length >= MAX_ROOMS_PER_HOST) {
      throw new Error("room limit reached for this host");
    }
    if (Object.keys(rooms).length >= MAX_ROOMS) {
      throw new Error("global room limit reached");
    }

    const roomId = randomUUID();
    const expiresAt = now + ROOM_TTL_MS;
    const mesh = await this.backend.provision(roomId, expiresAt);
    const host: RoomMember = { userId: input.hostUserId, joinedAt: now };

    const room: Room = {
      id: roomId,
      gameId: input.gameId,
      versionId: input.versionId,
      emulator: input.emulator,
      hostUserId: input.hostUserId,
      hostHeartbeatAt: now,
      members: [host],
      mesh,
      createdAt: now,
      expiresAt,
    };
    rooms[roomId] = room;
    await this.saveRooms(rooms);
    return room;
  }

  async get(roomId: string): Promise<Room | undefined> {
    const rooms = await this.loadRooms();
    const room = rooms[roomId];
    if (!room || room.expiresAt <= this.now()) return undefined;
    return room;
  }

  async list(gameId?: string): Promise<DiscoverableRoom[]> {
    const rooms = await this.loadRooms();
    const now = this.now();
    return Object.values(rooms)
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
    const rooms = await this.loadRooms();
    const room = rooms[roomId];
    if (!room || room.expiresAt <= this.now()) {
      throw new Error("room not found");
    }
    if (!room.members.some((member) => member.userId === userId)) {
      room.members.push({ userId, joinedAt: this.now() });
    }
    this.claimExpiredLease(room);
    await this.saveRooms(rooms);
    return room;
  }

  async heartbeat(roomId: string, userId: string): Promise<Room> {
    const rooms = await this.loadRooms();
    const room = rooms[roomId];
    if (!room || room.expiresAt <= this.now()) {
      throw new Error("room not found");
    }
    this.claimExpiredLease(room);
    if (room.hostUserId === userId) {
      room.hostHeartbeatAt = this.now();
    }
    await this.saveRooms(rooms);
    return room;
  }

  async leave(
    roomId: string,
    userId: string,
  ): Promise<{ closed: boolean; room?: Room }> {
    const rooms = await this.loadRooms();
    const room = rooms[roomId];
    if (!room) return { closed: false };

    if (room.hostUserId === userId) {
      Reflect.deleteProperty(rooms, roomId);
      const credentials = await this.loadCredentials();
      Reflect.deleteProperty(credentials, roomId);
      await this.storage.set(CREDENTIALS_KEY, credentials);
      await this.saveRooms(rooms);
      await this.backend.teardown(roomId);
      return { closed: true };
    }

    room.members = room.members.filter((member) => member.userId !== userId);
    await this.backend.revokeMember(roomId, userId);
    await this.saveRooms(rooms);
    return { closed: false, room };
  }

  /** Issue (or return the existing) server-side credential for a member. */
  async credential(roomId: string, userId: string): Promise<MeshCredential> {
    const room = await this.get(roomId);
    if (!room) throw new Error("room not found");
    if (!room.members.some((member) => member.userId === userId)) {
      throw new Error("not a room member");
    }

    const credentials = await this.loadCredentials();
    const roomCredentials = credentials[roomId] ?? {};
    const existing = roomCredentials[userId];
    if (existing && existing.expiresAt > this.now()) {
      return existing;
    }

    const secret = await this.backend.issueCredential(
      roomId,
      userId,
      room.mesh,
    );
    const credential: MeshCredential = {
      roomId,
      userId,
      secret,
      issuedAt: this.now(),
      expiresAt: room.expiresAt,
    };
    roomCredentials[userId] = credential;
    credentials[roomId] = roomCredentials;
    await this.storage.set(CREDENTIALS_KEY, credentials);
    return credential;
  }
}
