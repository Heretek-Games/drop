import Stream from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { createError } from "h3";

export interface SaveSlotRecord {
  historyObjectIds: string[];
  historyChecksums: string[];
}

/**
 * Dependencies the save pipeline needs. Declared structurally so the manager
 * can be unit-tested with fakes without importing the Prisma client, the
 * object backend, or the application config (which read live state).
 */
export interface SaveManagerDeps {
  prisma: {
    saveSlot: {
      findUnique(args: {
        where: { id: { userId: string; gameId: string; index: number } };
      }): Promise<SaveSlotRecord | null>;
      updateManyAndReturn(args: {
        where: { userId: string; gameId: string; index: number };
        data: {
          historyObjectIds: { push: string };
          historyChecksums: { push: string };
          lastUsedClientId?: string;
        };
      }): Promise<SaveSlotRecord[]>;
      updateMany(args: {
        where: { userId: string; gameId: string; index: number };
        data: { historyObjectIds: string[]; historyChecksums: string[] };
      }): Promise<{ count: number }>;
    };
  };
  objectHandler: {
    createWithStream(
      id: string,
      metadata: { [key: string]: string },
      permissions: string[],
    ): Promise<NodeJS.WritableStream>;
    deleteWithPermission(id: string, userId?: string): Promise<boolean>;
    deleteAsSystem(id: string): Promise<boolean>;
  };
  settings: {
    get(key: "saveSlotHistoryLimit" | "saveSlotSizeLimit"): Promise<number>;
  };
}

export class SaveManager {
  private readonly deps: SaveManagerDeps;

  constructor(deps: SaveManagerDeps) {
    this.deps = deps;
  }

  async deleteObjectFromSave(
    gameId: string,
    userId: string,
    index: number,
    objectId: string,
  ) {
    void gameId;
    void index;
    await this.deps.objectHandler.deleteWithPermission(objectId, userId);
  }

  async pushSave(
    gameId: string,
    userId: string,
    index: number,
    stream: NodeJS.ReadableStream,
    clientId: string | undefined = undefined,
  ) {
    const save = await this.deps.prisma.saveSlot.findUnique({
      where: {
        id: {
          userId,
          gameId,
          index,
        },
      },
    });
    if (!save)
      throw createError({ statusCode: 404, statusMessage: "Save not found" });

    const newSaveObjectId = randomUUID();
    const newSaveStream = await this.deps.objectHandler.createWithStream(
      newSaveObjectId,
      { saveSlot: JSON.stringify({ userId, gameId, index }) },
      // System-tracked object: grant the owner read access (same convention as
      // screenshots) so the desktop client can pull the archive back down.
      [`${userId}:read`],
    );
    if (!newSaveStream)
      throw createError({
        statusCode: 500,
        statusMessage: "Failed to create writing stream to storage backend.",
      });

    const hashStream = createHash("sha256");
    let totalBytes = 0;
    stream.on("data", (chunk: Buffer) => {
      hashStream.update(chunk);
      totalBytes += chunk.length;
    });

    await Stream.promises.pipeline(stream, newSaveStream);

    const sizeLimitMb = await this.deps.settings.get("saveSlotSizeLimit");
    if (totalBytes > sizeLimitMb * 1024 * 1024) {
      await this.deps.objectHandler.deleteAsSystem(newSaveObjectId);
      throw createError({
        statusCode: 413,
        statusMessage: "Save exceeds saveSlotSizeLimit",
      });
    }

    const hash = hashStream.digest("hex");

    if (!hash) {
      await this.deps.objectHandler.deleteAsSystem(newSaveObjectId);
      throw createError({
        statusCode: 500,
        statusMessage: "Hash failed to generate",
      });
    }

    const newSaves = await this.deps.prisma.saveSlot.updateManyAndReturn({
      where: {
        userId,
        gameId,
        index,
      },
      data: {
        historyObjectIds: {
          push: newSaveObjectId,
        },
        historyChecksums: {
          push: hash,
        },
        ...(clientId && { lastUsedClientId: clientId }),
      },
    });
    const newSave = newSaves.at(0);
    if (!newSave)
      throw createError({ statusCode: 404, message: "Save not found" });

    const historyLimit = await this.deps.settings.get("saveSlotHistoryLimit");
    if (newSave.historyObjectIds.length > historyLimit) {
      // Delete previous
      const safeFromIndex = newSave.historyObjectIds.length - historyLimit;

      const toDelete = newSave.historyObjectIds.slice(0, safeFromIndex);
      const toKeepObjects = newSave.historyObjectIds.slice(safeFromIndex);
      const toKeepHashes = newSave.historyChecksums.slice(safeFromIndex);

      // Delete objects first, so if we error out, we don't lose track of objects in backend
      for (const objectId of toDelete) {
        await this.deleteObjectFromSave(gameId, userId, index, objectId);
      }

      const { count } = await this.deps.prisma.saveSlot.updateMany({
        where: {
          userId,
          gameId,
          index,
        },
        data: {
          historyObjectIds: toKeepObjects,
          historyChecksums: toKeepHashes,
        },
      });
      if (count == 0) {
        throw createError({ statusCode: 404, message: "Save not found" });
      }
    }
  }
}
