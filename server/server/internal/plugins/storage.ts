import fs from "node:fs/promises";
import path from "node:path";
import { systemConfig } from "../config/sys-conf";
import type { PluginStorage } from "./types";

export class FilePluginStorage implements PluginStorage {
  private readonly filePath: string;
  private readonly dirPath: string;
  private cache: Record<string, unknown> | null = null;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(pluginId: string) {
    this.dirPath = path.join(systemConfig.getDataFolder(), "plugins", pluginId);
    this.filePath = path.join(this.dirPath, "state.json");
  }

  private async load(): Promise<Record<string, unknown>> {
    if (this.cache !== null) {
      return this.cache;
    }

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
    this.writeLock = this.writeLock.then(async () => {
      await fs.mkdir(this.dirPath, { recursive: true });
      const tempPath = `${this.filePath}.tmp.${Date.now()}`;
      await fs.writeFile(tempPath, dataToSave, "utf-8");
      await fs.rename(tempPath, this.filePath);
    });
    await this.writeLock;
  }

  async get<T>(key: string): Promise<T | null> {
    const data = await this.load();
    if (Object.prototype.hasOwnProperty.call(data, key)) {
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
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      Reflect.deleteProperty(data, key);
      await this.persist();
    }
  }

  async listKeys(): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data);
  }
}
