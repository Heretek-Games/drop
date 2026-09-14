import Stream from "node:stream";
import prisma from "../db/database";
import { applicationSettings } from "../config/application-configuration";
import objectHandler from "../objects";
import { randomUUID, createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Raised by the measuring stream when a save exceeds `saveSlotSizeLimit`. */
class SaveSizeLimitError extends Error {
  constructor() {
    super("save exceeds saveSlotSizeLimit");
    this.name = "SaveSizeLimitError";
  }
}

class SaveManager {
  async deleteObjectFromSave(
    gameId: string,
    userId: string,
    index: number,
    objectId: string,
  ): Promise<boolean> {
    void gameId;
    void userId;
    void index;
    // Save objects are system-tracked (`${userId}:read`) and the id is taken
    // from the caller's own slot history, so reclaim them as the system.
    // `deleteWithPermission` would require a `delete` grant the object is
    // deliberately never given, silently leaking every pruned snapshot.
    return await objectHandler.deleteAsSystem(objectId);
  }

  async pushSave(
    gameId: string,
    userId: string,
    index: number,
    stream: IncomingMessage,
    clientId: string | undefined = undefined,
  ) {
    const save = await prisma.saveSlot.findUnique({
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
    const newSaveStream = await objectHandler.createWithStream(
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

    const sizeLimitMb = await applicationSettings.get("saveSlotSizeLimit");
    const sizeLimitBytes = sizeLimitMb * 1024 * 1024;

    const hashStream = createHash("sha256");
    let totalBytes = 0;

    // Measure while streaming so an oversized payload is rejected before the
    // whole archive reaches disk, rather than after an unbounded write.
    const measuringStream = new Stream.Transform({
      transform(chunk: Buffer, _encoding, callback) {
        totalBytes += chunk.length;
        if (totalBytes > sizeLimitBytes) {
          callback(new SaveSizeLimitError());
          return;
        }
        hashStream.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await Stream.promises.pipeline(stream, measuringStream, newSaveStream);
    } catch (error) {
      await objectHandler.deleteAsSystem(newSaveObjectId);
      if (error instanceof SaveSizeLimitError) {
        throw createError({
          statusCode: 413,
          statusMessage: "Save exceeds saveSlotSizeLimit",
        });
      }
      throw error;
    }

    const hash = hashStream.digest("hex");

    if (!hash) {
      await objectHandler.deleteAsSystem(newSaveObjectId);
      throw createError({
        statusCode: 500,
        statusMessage: "Hash failed to generate",
      });
    }

    const newSaves = await prisma.saveSlot.updateManyAndReturn({
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

    const historyLimit = await applicationSettings.get("saveSlotHistoryLimit");
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

      const { count } = await prisma.saveSlot.updateMany({
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

export const saveManager = new SaveManager();
export default saveManager;
