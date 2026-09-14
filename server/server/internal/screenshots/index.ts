import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import objectHandler from "../objects";
import stream from "node:stream/promises";
import prisma from "../db/database";
import { screenshotObjectPermissions } from "./permissions";

export { screenshotObjectPermissions } from "./permissions";

class ScreenshotManager {
  /**
   * Gets a specific screenshot
   * @param id
   * @returns
   */
  async get(id: string) {
    return await prisma.screenshot.findUnique({
      where: {
        id,
      },
    });
  }

  /**
   * Get all user screenshots
   * @param userId
   * @returns
   */
  async getUserAll(userId: string) {
    const results = await prisma.screenshot.findMany({
      where: {
        userId,
      },
    });
    return results;
  }

  /**
   * Get all user screenshots in a specific game
   * @param userId
   * @param gameId
   * @returns
   */
  async getUserAllByGame(userId: string, gameId: string) {
    const results = await prisma.screenshot.findMany({
      where: {
        gameId,
        userId,
      },
    });
    return results;
  }

  /**
   * Public (non-private) screenshots for a game — the community gallery.
   * @param gameId
   */
  async getPublicAllByGame(gameId: string) {
    return await prisma.screenshot.findMany({
      where: {
        gameId,
        private: false,
      },
    });
  }

  /**
   * Publish or withdraw a screenshot. The caller must verify ownership first;
   * this synchronizes the object permissions with the new visibility.
   * @param screenshotId
   * @param isPrivate
   */
  async setVisibility(screenshotId: string, isPrivate: boolean) {
    const screenshot = await prisma.screenshot.findUnique({
      where: { id: screenshotId },
    });
    if (!screenshot) return false;
    await objectHandler.setPermissions(
      screenshot.objectId,
      screenshotObjectPermissions(screenshot.userId, isPrivate),
    );
    const { count } = await prisma.screenshot.updateMany({
      where: { id: screenshotId },
      data: { private: isPrivate },
    });
    return count > 0;
  }

  /**
   * Delete a specific screenshot
   * @param id
   */
  async delete(id: string) {
    const screenshot = await prisma.screenshot.findUnique({ where: { id } });
    if (!screenshot) return false;
    // eslint-disable-next-line drop/no-prisma-delete
    await prisma.screenshot.delete({
      where: {
        id,
      },
    });
    await objectHandler.deleteAsSystem(screenshot.objectId);
    return true;
  }

  /**
   * Allows a user to upload a screenshot
   * @param userId
   * @param gameId
   * @param inputStream
   */
  async upload(userId: string, gameId: string, inputStream: IncomingMessage) {
    const objectId = randomUUID();
    const saveStream = await objectHandler.createWithStream(
      objectId,
      {
        // TODO: set createAt to the time screenshot was taken
        createdAt: new Date().toISOString(),
      },
      [`${userId}:read`], // This is a system tracked object, so we don't want users to have direct write access to it
    );
    if (!saveStream)
      throw createError({
        statusCode: 500,
        statusMessage: "Failed to create writing stream to storage backend.",
      });

    // pipe into object store
    await stream.pipeline(inputStream, saveStream);

    await prisma.screenshot.create({
      data: {
        gameId,
        userId,
        objectId,
        private: true,
      },
    });
  }
}

export const screenshotManager = new ScreenshotManager();
export default screenshotManager;
