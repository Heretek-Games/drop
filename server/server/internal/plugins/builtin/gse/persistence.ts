import type { PluginStorage } from "../../types";
import type { MeshCredential, Room } from "./types";

/**
 * Durable room/credential persistence. Two implementations exist:
 * `StorageRoomPersistence` (plugin storage; tests and dev) and
 * `PrismaRoomPersistence` (Drop's Postgres database; production default).
 */
export interface RoomPersistence {
  listRooms(): Promise<Room[]>;
  getRoom(id: string): Promise<Room | undefined>;
  saveRoom(room: Room): Promise<void>;
  deleteRoom(id: string): Promise<void>;
  getCredentials(roomId: string): Promise<Record<string, MeshCredential>>;
  saveCredential(roomId: string, credential: MeshCredential): Promise<void>;
  deleteCredentials(roomId: string): Promise<void>;
}

const ROOMS_KEY = "rooms";
const CREDENTIALS_KEY = "credentials";

/** Plugin-storage persistence: two JSON blobs under the plugin's data dir. */
export class StorageRoomPersistence implements RoomPersistence {
  constructor(private readonly storage: PluginStorage) {}

  private async loadRooms(): Promise<Record<string, Room>> {
    return (await this.storage.get<Record<string, Room>>(ROOMS_KEY)) ?? {};
  }

  private async loadCredentials(): Promise<
    Record<string, Record<string, MeshCredential>>
  > {
    return (
      (await this.storage.get<Record<string, Record<string, MeshCredential>>>(
        CREDENTIALS_KEY,
      )) ?? {}
    );
  }

  async listRooms(): Promise<Room[]> {
    return Object.values(await this.loadRooms());
  }

  async getRoom(id: string): Promise<Room | undefined> {
    return (await this.loadRooms())[id];
  }

  async saveRoom(room: Room): Promise<void> {
    const rooms = await this.loadRooms();
    rooms[room.id] = room;
    await this.storage.set(ROOMS_KEY, rooms);
  }

  async deleteRoom(id: string): Promise<void> {
    const rooms = await this.loadRooms();
    Reflect.deleteProperty(rooms, id);
    await this.storage.set(ROOMS_KEY, rooms);
  }

  async getCredentials(
    roomId: string,
  ): Promise<Record<string, MeshCredential>> {
    return (await this.loadCredentials())[roomId] ?? {};
  }

  async saveCredential(
    roomId: string,
    credential: MeshCredential,
  ): Promise<void> {
    const credentials = await this.loadCredentials();
    credentials[roomId] = credentials[roomId] ?? {};
    credentials[roomId][credential.userId] = credential;
    await this.storage.set(CREDENTIALS_KEY, credentials);
  }

  async deleteCredentials(roomId: string): Promise<void> {
    const credentials = await this.loadCredentials();
    Reflect.deleteProperty(credentials, roomId);
    await this.storage.set(CREDENTIALS_KEY, credentials);
  }
}
