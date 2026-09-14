import test from "node:test";
import assert from "node:assert/strict";
import { Readable, type Writable } from "node:stream";
import type pino from "pino";
import {
  ObjectBackend,
  ObjectHandler,
  type ObjectMetadata,
  type Source,
} from "../objectHandler";

const OWNER = "user-1";

class MemoryBackend extends ObjectBackend {
  private readonly objects = new Map<string, Buffer>();
  private readonly metadata = new Map<string, ObjectMetadata>();

  seed(id: string, content: Buffer, permissions: string[]) {
    this.objects.set(id, content);
    this.metadata.set(id, {
      mime: "application/octet-stream",
      permissions,
      userMetadata: {},
    });
  }

  content(id: string) {
    return this.objects.get(id);
  }

  async fetch(id: string): Promise<Source | undefined> {
    const content = this.objects.get(id);
    return content ? Readable.from(content) : undefined;
  }

  async write(id: string, source: Source): Promise<boolean> {
    if (!this.objects.has(id)) return false;
    if (source instanceof Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of source)
        chunks.push(Buffer.from(chunk as Buffer));
      this.objects.set(id, Buffer.concat(chunks));
    } else {
      this.objects.set(id, source);
    }
    return true;
  }

  async startWriteStream(_id: string): Promise<Writable | undefined> {
    return undefined;
  }

  async create(
    id: string,
    source: Source,
    metadata: ObjectMetadata,
  ): Promise<string | undefined> {
    this.seed(id, Buffer.from(""), metadata.permissions);
    await this.write(id, source);
    return id;
  }

  async createWithWriteStream(
    id: string,
    metadata: ObjectMetadata,
  ): Promise<Writable | undefined> {
    this.seed(id, Buffer.from(""), metadata.permissions);
    return undefined;
  }

  async delete(id: string) {
    this.objects.delete(id);
    this.metadata.delete(id);
    return true;
  }

  async fetchMetadata(id: string) {
    return this.metadata.get(id);
  }

  async writeMetadata(id: string, metadata: ObjectMetadata) {
    this.metadata.set(id, metadata);
    return true;
  }

  async fetchHash() {
    return undefined;
  }

  async listAll() {
    return [...this.objects.keys()];
  }

  async cleanupMetadata(_taskLogger: pino.Logger) {
    return;
  }
}

test("writeWithPermissions refuses to overwrite by default", async () => {
  const backend = new MemoryBackend();
  backend.seed("obj", Buffer.from("original"), [`${OWNER}:write`]);
  const handler = new ObjectHandler(backend);

  let fetched = false;
  const result = await handler.writeWithPermissions(
    "obj",
    async () => {
      fetched = true;
      return Buffer.from("pwned");
    },
    OWNER,
  );

  assert.equal(result, false);
  assert.equal(fetched, false);
  assert.equal(backend.content("obj")?.toString(), "original");
});

test("writeWithPermissions overwrites when the caller opts in with write permission", async () => {
  const backend = new MemoryBackend();
  backend.seed("obj", Buffer.from("original"), [`${OWNER}:write`]);
  const handler = new ObjectHandler(backend);

  const result = await handler.writeWithPermissions(
    "obj",
    async () => Buffer.from("updated"),
    OWNER,
    { allowOverwrite: true },
  );

  assert.equal(result, true);
  assert.equal(backend.content("obj")?.toString(), "updated");
});

test("writeWithPermissions still requires write permission when opted in", async () => {
  const backend = new MemoryBackend();
  backend.seed("obj", Buffer.from("original"), [`${OWNER}:read`]);
  const handler = new ObjectHandler(backend);

  const result = await handler.writeWithPermissions(
    "obj",
    async () => Buffer.from("pwned"),
    OWNER,
    { allowOverwrite: true },
  );

  assert.equal(result, false);
  assert.equal(backend.content("obj")?.toString(), "original");
});

test("writeWithPermissions refuses unknown objects", async () => {
  const backend = new MemoryBackend();
  const handler = new ObjectHandler(backend);

  const result = await handler.writeWithPermissions(
    "missing",
    async () => Buffer.from("pwned"),
    OWNER,
    { allowOverwrite: true },
  );

  assert.equal(result, false);
});
