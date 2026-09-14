import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginStorage } from "./types";

function defaultDataFolder(): string {
  return process.env.DATA ?? "./.data/data";
}

export class FilePluginStorage implements PluginStorage {
  private readonly filePath: string;
  private readonly schemaPath: string;
  private readonly dirPath: string;
  private readonly legacyDirPath: string;
  private cache: Record<string, unknown> | null = null;
  private writeLock: Promise<void> = Promise.resolve();
  private migrationDone = false;

  constructor(pluginId: string, dataDir?: string) {
    const base = dataDir ?? defaultDataFolder();
    this.dirPath = path.join(base, "plugin-data", pluginId);
    this.filePath = path.join(this.dirPath, "state.json");
    this.schemaPath = path.join(this.dirPath, "schema.json");
    this.legacyDirPath = path.join(base, "plugins", pluginId);
  }

  private async migrateLegacyFiles(): Promise<void> {
    if (this.migrationDone) return;
    this.migrationDone = true;
    try {
      const legacyState = path.join(this.legacyDirPath, "state.json");
      const legacySchema = path.join(this.legacyDirPath, "schema.json");
      await fs.mkdir(this.dirPath, { recursive: true });

      try {
        await fs.access(this.filePath);
      } catch {
        try {
          const content = await fs.readFile(legacyState, "utf-8");
          await fs.writeFile(this.filePath, content, "utf-8");
          await fs.unlink(legacyState).catch(() => {});
        } catch {
          // No legacy state
        }
      }

      try {
        await fs.access(this.schemaPath);
      } catch {
        try {
          const content = await fs.readFile(legacySchema, "utf-8");
          await fs.writeFile(this.schemaPath, content, "utf-8");
          await fs.unlink(legacySchema).catch(() => {});
        } catch {
          // No legacy schema
        }
      }
    } catch {
      // Best effort migration
    }
  }

  async getSchemaVersion(): Promise<number> {
    await this.migrateLegacyFiles();
    try {
      const raw = await fs.readFile(this.schemaPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      return typeof parsed.version === "number" ? parsed.version : 0;
    } catch {
      return 0;
    }
  }

  async setSchemaVersion(version: number): Promise<void> {
    await fs.mkdir(this.dirPath, { recursive: true });
    const tempPath = `${this.schemaPath}.tmp.${randomUUID()}`;
    await fs.writeFile(tempPath, JSON.stringify({ version }, null, 2), "utf-8");
    await fs.rename(tempPath, this.schemaPath);
  }

  private async load(): Promise<Record<string, unknown>> {
    if (this.cache !== null) {
      return this.cache;
    }

    await this.migrateLegacyFiles();

    try {
      const data = await fs.readFile(this.filePath, "utf-8");
      this.cache = JSON.parse(data) as Record<string, unknown>;
      return this.cache;
    } catch {
      this.cache = {};
      return this.cache;
    }
  }

  private async persist(): Promise<void> {
    const dataToSave = JSON.stringify(this.cache ?? {}, null, 2);
    // Recover from a failed write so the lock is not permanently poisoned.
    this.writeLock = this.writeLock
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(this.dirPath, { recursive: true });
        const tempPath = `${this.filePath}.tmp.${randomUUID()}`;
        await fs.writeFile(tempPath, dataToSave, "utf-8");
        await fs.rename(tempPath, this.filePath);
      });
    await this.writeLock;
  }

  async get<T>(key: string): Promise<T | null> {
    const data = await this.load();
    if (Object.hasOwn(data, key)) {
      return data[key] as T;
    }
    return null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const data = await this.load();
    data[key] = value;
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    const data = await this.load();
    if (Object.hasOwn(data, key)) {
      Reflect.deleteProperty(data, key);
      await this.persist();
    }
  }

  async listKeys(): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data);
  }
}
