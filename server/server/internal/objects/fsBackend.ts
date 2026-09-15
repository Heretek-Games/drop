import type { ObjectMetadata, ObjectReference, Source } from "./objectHandler";
import { ObjectBackend, objectMetadata } from "./objectHandler";

import fs from "node:fs";
import path from "node:path";
import Stream, { Readable } from "node:stream";
import { createHash } from "node:crypto";
import prisma from "../db/database";
import cacheHandler from "../cache";
import { systemConfig } from "../config/sys-conf";
import { type } from "arktype";
import { logger } from "~/server/internal/logging";
import type pino from "pino";

export class FsObjectBackend extends ObjectBackend {
  private baseObjectPath: string;
  private baseMetadataPath: string;

  private hashStore = new FsHashStore();
  private metadataCache =
    cacheHandler.createCache<ObjectMetadata>("ObjectMetadata");

  constructor() {
    super();
    const basePath = path.join(systemConfig.getDataFolder(), "objects");
    this.baseObjectPath = path.join(basePath, "objects");
    this.baseMetadataPath = path.join(basePath, "metadata");

    fs.mkdirSync(this.baseObjectPath, { recursive: true });
    fs.mkdirSync(this.baseMetadataPath, { recursive: true });
  }

  async fetch(id: ObjectReference) {
    const objectPath = path.join(this.baseObjectPath, id);
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(objectPath, "r");
    } catch {
      return undefined;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        return undefined;
      }
    } catch {
      await handle.close();
      return undefined;
    }
    // createReadStream on the handle keeps reads tied to the opened inode and closes the handle on completion.
    return handle.createReadStream({ autoClose: true });
  }

  async write(id: ObjectReference, source: Source): Promise<boolean> {
    const objectPath = path.join(this.baseObjectPath, id);
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(objectPath, "r+");
    } catch {
      return false;
    }

    // remove item from cache
    await this.hashStore.delete(id);

    try {
      if (source instanceof Readable) {
        // Truncate first so overwriting a longer object doesn't leave stale bytes
        await handle.truncate(0);
        const outputStream = handle.createWriteStream({ autoClose: true });
        await Stream.promises.pipeline(source, outputStream);
        return true;
      }

      if (source instanceof Buffer) {
        await handle.truncate(0);
        await handle.writeFile(source);
        return true;
      }

      return false;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async startWriteStream(id: ObjectReference) {
    const objectPath = path.join(this.baseObjectPath, id);
    try {
      const handle = await fs.promises.open(objectPath, "r+");
      // remove item from cache
      await this.hashStore.delete(id);
      return handle.createWriteStream({ autoClose: true });
    } catch {
      return undefined;
    }
  }

  async create(
    id: string,
    source: Source,
    metadata: ObjectMetadata,
  ): Promise<ObjectReference | undefined> {
    const objectPath = path.join(this.baseObjectPath, id);
    const metadataPath = path.join(this.baseMetadataPath, `${id}.json`);
    if (fs.existsSync(objectPath) || fs.existsSync(metadataPath))
      return undefined;

    // Write metadata
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));

    // Create file so write passes
    fs.writeFileSync(objectPath, "");

    // Call write
    await this.write(id, source);

    return id;
  }

  async createWithWriteStream(id: string, metadata: ObjectMetadata) {
    const objectPath = path.join(this.baseObjectPath, id);
    const metadataPath = path.join(this.baseMetadataPath, `${id}.json`);
    if (fs.existsSync(objectPath) || fs.existsSync(metadataPath))
      return undefined;

    // Write metadata
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));

    // Create file so write passes
    fs.writeFileSync(objectPath, "");

    const stream = await this.startWriteStream(id);
    if (!stream) throw new Error("Could not create write stream");
    return stream;
  }

  async delete(id: ObjectReference): Promise<boolean> {
    const objectPath = path.join(this.baseObjectPath, id);
    if (!fs.existsSync(objectPath)) return true;
    fs.rmSync(objectPath);
    const metadataPath = path.join(this.baseMetadataPath, `${id}.json`);
    if (!fs.existsSync(metadataPath)) return true;
    fs.rmSync(metadataPath);
    // remove item from caches
    await this.metadataCache.remove(id);
    await this.hashStore.delete(id);
    return true;
  }

  async fetchMetadata(
    id: ObjectReference,
  ): Promise<ObjectMetadata | undefined> {
    const cacheResult = await this.metadataCache.get(id);
    if (cacheResult !== null) return cacheResult;

    const metadataPath = path.join(this.baseMetadataPath, `${id}.json`);
    if (!fs.existsSync(metadataPath)) return undefined;
    const metadataRaw = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    const metadata = objectMetadata(metadataRaw);
    if (metadata instanceof type.errors) {
      logger.error(
        { summary: metadata.summary },
        "FsObjectBackend#fetchMetadata",
      );
      return undefined;
    }
    await this.metadataCache.set(id, metadata);
    return metadata;
  }

  async writeMetadata(
    id: ObjectReference,
    metadata: ObjectMetadata,
  ): Promise<boolean> {
    const metadataPath = path.join(this.baseMetadataPath, `${id}.json`);
    if (!fs.existsSync(metadataPath)) return false;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    await this.metadataCache.set(id, metadata);
    return true;
  }

  async fetchHash(id: ObjectReference): Promise<string | undefined> {
    const cacheResult = await this.hashStore.get(id);
    // FsHashStore#get returns undefined on a database miss, not null
    if (cacheResult) return cacheResult;

    const obj = await this.fetch(id);
    if (obj === undefined) return;

    // Upstream Drop uses md5 for ETag hashing
    const hash = createHash("md5");

    try {
      await Stream.promises.pipeline(obj, hash);
      const hashResult = hash.digest("hex");
      await this.hashStore.save(id, hashResult);
      return hashResult;
    } catch {
      return undefined;
    }
  }

  async listAll(): Promise<string[]> {
    return fs.readdirSync(this.baseObjectPath);
  }

  async cleanupMetadata(taskLogger: pino.Logger) {
    const cleanupLogger = taskLogger ?? logger;

    const metadataFiles = fs.readdirSync(this.baseMetadataPath);
    const objects = await this.listAll();

    const extraFiles = metadataFiles.filter(
      (file) => !objects.includes(file.replace(/\.json$/, "")),
    );
    cleanupLogger.info(
      `[FsObjectBackend#cleanupMetadata]: Found ${extraFiles.length} metadata files without corresponding objects.`,
    );
    for (const file of extraFiles) {
      const filePath = path.join(this.baseMetadataPath, file);
      try {
        fs.rmSync(filePath);
        cleanupLogger.info(
          `[FsObjectBackend#cleanupMetadata]: Removed ${file}`,
        );
      } catch (error) {
        cleanupLogger.error(
          { error },
          `[FsObjectBackend#cleanupMetadata]: Failed to remove ${file}`,
        );
      }
    }
  }
}

class FsHashStore {
  private cache = cacheHandler.createCache<string>("ObjectHashStore");

  async get(id: ObjectReference) {
    const cacheRes = await this.cache.get(id);
    if (cacheRes !== null) {
      return cacheRes;
    }

    const objectHash = await prisma.objectHash.findUnique({
      where: {
        id,
      },
      select: {
        hash: true,
      },
    });
    if (objectHash === null) return undefined;
    await this.cache.set(id, objectHash.hash);
    return objectHash.hash;
  }

  async save(id: ObjectReference, hash: string) {
    await prisma.objectHash.upsert({
      where: {
        id,
      },
      create: {
        id,
        hash,
      },
      update: {
        hash,
      },
    });
    await this.cache.set(id, hash);
  }

  async delete(id: ObjectReference) {
    await this.cache.remove(id);
    await prisma.objectHash.deleteMany({
      where: {
        id,
      },
    });
  }
}
