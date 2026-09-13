import type { RoomPersistence } from "./persistence";
import type { MeshCredential, Room } from "./types";

/**
 * Postgres-backed room persistence using Drop's Prisma client.
 *
 * The client is imported lazily so the plugin (and its unit tests) do not
 * require a database unless this implementation is actually used.
 */
export class PrismaRoomPersistence implements RoomPersistence {
  private async db() {
    const { default: prisma } = await import("~/server/internal/db/database");
    return prisma;
  }

  async listRooms(): Promise<Room[]> {
    const prisma = await this.db();
    const rows = await prisma.gseRoom.findMany();
    return rows.map((row) => row.payload as unknown as Room);
  }

  async getRoom(id: string): Promise<Room | undefined> {
    const prisma = await this.db();
    const row = await prisma.gseRoom.findUnique({ where: { id } });
    return row ? (row.payload as unknown as Room) : undefined;
  }

  async saveRoom(room: Room): Promise<void> {
    const prisma = await this.db();
    const data = {
      id: room.id,
      gameId: room.gameId,
      hostUserId: room.hostUserId,
      expiresAt: BigInt(room.expiresAt),
      payload: room as unknown as object,
    };
    await prisma.gseRoom.upsert({
      where: { id: room.id },
      create: data,
      update: data,
    });
  }

  async deleteRoom(id: string): Promise<void> {
    const prisma = await this.db();
    await prisma.gseRoom.deleteMany({ where: { id } });
  }

  async deleteRoomData(id: string): Promise<void> {
    const prisma = await this.db();
    await prisma.$transaction([
      prisma.gseRoom.deleteMany({ where: { id } }),
      prisma.gseCredential.deleteMany({ where: { roomId: id } }),
    ]);
  }

  async getCredentials(
    roomId: string,
  ): Promise<Record<string, MeshCredential>> {
    const prisma = await this.db();
    const rows = await prisma.gseCredential.findMany({ where: { roomId } });
    const result: Record<string, MeshCredential> = {};
    for (const row of rows) {
      result[row.userId] = row.payload as unknown as MeshCredential;
    }
    return result;
  }

  async saveCredential(
    roomId: string,
    credential: MeshCredential,
  ): Promise<void> {
    const prisma = await this.db();
    // Redact the backend secret at rest; the coordinator re-issues it on
    // demand (the assigned address and expiry are retained).
    const redacted: MeshCredential = { ...credential, secret: "" };
    const data = {
      roomId,
      userId: credential.userId,
      expiresAt: BigInt(credential.expiresAt),
      payload: redacted as unknown as object,
    };
    await prisma.gseCredential.upsert({
      where: { roomId_userId: { roomId, userId: credential.userId } },
      create: data,
      update: data,
    });
  }

  async deleteCredentials(roomId: string): Promise<void> {
    const prisma = await this.db();
    await prisma.gseCredential.deleteMany({ where: { roomId } });
  }

  async deleteExpiredCredentials(before: number): Promise<number> {
    const prisma = await this.db();
    const result = await prisma.gseCredential.deleteMany({
      where: { expiresAt: { lte: BigInt(before) } },
    });
    return result.count;
  }
}
