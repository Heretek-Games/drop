/**
 * Objects are basically files, like images or downloads, that have a set of metadata and permissions attached
 * They're served by the API from the /api/v1/object/${objectId} endpoint.
 *
 * It supports streams and buffers, depending on the use case. Buffers will likely only be used internally if
 * the data needs to be manipulated somehow.
 *
 * Objects are designed to be created once, and link to a single ID. For example, each user gets a single object
 * that's tied to their profile picture. If they want to update their profile picture, they overwrite that object.
 *
 * Permissions are a list of strings. Each permission string is in the id:permission format. Eg
 * anonymous:read
 * myUserId:read
 * anotherUserId:write
 */

import { type } from "arktype";
import { parse as getMimeTypeBuffer } from "file-type-mime";
import type pino from "pino";
import type { Writable } from "node:stream";
import { Readable } from "node:stream";
import { getMimeType as getMimeTypeStream } from "stream-mime-type";

export const objectMetadata = type({
  mime: "string",
  permissions: "string[]",
  userMetadata: {
    "[string]": "string",
  },
});
export type ObjectMetadata = typeof objectMetadata.infer;

export enum ObjectPermission {
  Read = "read",
  Write = "write",
  Delete = "delete",
}
const ObjectPermissionPriority: Array<ObjectPermission> = [
  ObjectPermission.Read,
  ObjectPermission.Write,
  ObjectPermission.Delete,
];

export type Object = { mime: string; data: Source };

export type Source = Readable | Buffer;

export abstract class ObjectBackend {
  // Interface functions, not designed to be called directly.
  // They don't check permissions to provide any utilities
  abstract fetch(id: string): Promise<Source | undefined>;
  abstract write(id: string, source: Source): Promise<boolean>;
  abstract startWriteStream(id: string): Promise<Writable | undefined>;
  abstract create(
    id: string,
    source: Source,
    metadata: ObjectMetadata,
  ): Promise<string | undefined>;
  abstract createWithWriteStream(
    id: string,
    metadata: ObjectMetadata,
  ): Promise<Writable | undefined>;
  abstract delete(id: string): Promise<boolean>;
  abstract fetchMetadata(id: string): Promise<ObjectMetadata | undefined>;
  abstract writeMetadata(
    id: string,
    metadata: ObjectMetadata,
  ): Promise<boolean>;
  abstract fetchHash(id: string): Promise<string | undefined>;
  abstract listAll(): Promise<string[]>;
  abstract cleanupMetadata(taskLogger: pino.Logger): Promise<void>;
}

export class ObjectHandler {
  private readonly backend: ObjectBackend;

  constructor(backend: ObjectBackend) {
    this.backend = backend;
  }

  private async fetchMimeType(source: Source) {
    if (source instanceof ReadableStream) {
      source = Readable.from(source);
    }
    if (source instanceof Readable) {
      const { stream, mime } = await getMimeTypeStream(source);
      return { source: Readable.from(stream), mime: mime };
    }
    if (source instanceof Buffer) {
      const mime =
        getMimeTypeBuffer(new Uint8Array(source).buffer)?.mime ??
        "application/octet-stream";
      return { source: source, mime };
    }

    return { source: undefined, mime: undefined };
  }

  async createFromSource(
    id: string,
    sourceFetcher: () => Promise<Source>,
    metadata: { [key: string]: string },
    permissions: Array<string>,
  ) {
    const { source, mime } = await this.fetchMimeType(await sourceFetcher());
    if (!mime)
      throw new Error("Unable to calculate MIME type - is the source empty?");

    await this.backend.create(id, source, {
      permissions,
      userMetadata: metadata,
      mime,
    });
  }

  async createWithStream(
    id: string,
    metadata: { [key: string]: string },
    permissions: Array<string>,
  ) {
    return this.backend.createWithWriteStream(id, {
      permissions,
      userMetadata: metadata,
      mime: "application/octet-stream",
    });
  }

  // We only need one permission, so use some instead of filter for speed
  private hasAnyPermissions(permissions: string[], userId?: string) {
    return permissions.some((e) => {
      if (userId !== undefined && e.startsWith(userId)) return true;
      if (userId !== undefined && e.startsWith("internal")) return true;
      if (e.startsWith("anonymous")) return true;
      return false;
    });
  }

  private fetchPermissions(permissions: string[], userId?: string) {
    return (
      permissions
        .filter((e) => {
          if (userId !== undefined && e.startsWith(userId)) return true;
          if (userId !== undefined && e.startsWith("internal")) return true;
          if (e.startsWith("anonymous")) return true;
          return false;
        })
        // Strip IDs from permissions
        .map((e) => e.split(":").at(1))
        // Map to priority according to array
        .map((e) =>
          e === undefined
            ? -1
            : (ObjectPermissionPriority as string[]).indexOf(e),
        )
    );
  }

  /**
   * Checks if user has perms to access the object without opening the file stream
   * @param id object id
   * @param userId user to check, or act as anon user
   * @returns metadata summary if permitted, undefined otherwise
   */
  async checkPermission(
    id: string,
    userId?: string,
  ): Promise<{ mime: string } | undefined> {
    const metadata = await this.backend.fetchMetadata(id);
    if (!metadata) return undefined;

    if (!this.hasAnyPermissions(metadata.permissions, userId)) return undefined;

    return { mime: metadata.mime };
  }

  /**
   * Fetches raw object source from backend
   * @param id object id
   * @returns source
   */
  async fetch(id: string) {
    return await this.backend.fetch(id);
  }

  /**
   * Fetches object, but also checks if user has perms to access it
   * @param id object id
   * @param userId user to check, or act as anon user
   * @returns
   */
  async fetchWithPermissions(id: string, userId?: string) {
    const metadata = await this.backend.fetchMetadata(id);
    if (!metadata) return;

    if (!this.hasAnyPermissions(metadata.permissions, userId)) return;

    // Because any permission can be read or up, we automatically know we can read this object
    // So just straight return the object
    const source = await this.backend.fetch(id);
    if (!source) return undefined;
    const object: Object = {
      data: source,
      mime: metadata.mime,
    };
    return object;
  }

  /**
   * Fetch object hash. Permissions check should be done on read
   * @param id object id
   * @returns
   */
  async fetchHash(id: string) {
    return await this.backend.fetchHash(id);
  }

  /**
   *
   * @param id object id
   * @param sourceFetcher callback used to provide image
   * @param userId user to check, or act as anon user
   * @param options overwrite must be opted into explicitly
   * @returns
   * @description If we need to fetch a remote resource, it doesn't make sense
   * to immediately fetch the object, *then* check permissions.
   * Instead the caller can pass a simple anonymous function, like
   * () => $dropFetch('/my-image');
   * And if we actually have permission to write, it fetches it then.
   *
   * Objects are create-once by default: an existing object is never clobbered
   * unless the caller opts in. The only caller that does is the generic
   * `POST /api/v1/object/[id]` update endpoint, whose ACL explicitly grants
   * `object:update`; every other upload path creates a fresh object id.
   */
  async writeWithPermissions(
    id: string,
    sourceFetcher: () => Promise<Source>,
    userId?: string,
    options?: { allowOverwrite?: boolean },
  ) {
    const metadata = await this.backend.fetchMetadata(id);
    if (!metadata) return false;

    const permissions = this.fetchPermissions(metadata.permissions, userId);

    const requiredPermissionIndex = 1;
    const hasPermission = permissions.some((e) => e >= requiredPermissionIndex);

    if (!hasPermission) return false;

    if (!options?.allowOverwrite) return false;

    const source = await sourceFetcher();
    const result = await this.backend.write(id, source);

    return result;
  }

  /**
   *
   * @param id object id
   * @param userId user to check, or act as anon user
   * @returns
   */
  async deleteWithPermission(id: string, userId?: string) {
    const metadata = await this.backend.fetchMetadata(id);
    if (!metadata) return false;

    const permissions = this.fetchPermissions(metadata.permissions, userId);

    const requiredPermissionIndex = 2;
    const hasPermission = permissions.some((e) => e >= requiredPermissionIndex);

    if (!hasPermission) return false;

    const result = await this.backend.delete(id);
    return result;
  }

  /**
   * Deletes object without checking permission
   * @param id
   * @returns
   */
  async deleteAsSystem(id: string) {
    return await this.backend.delete(id);
  }

  /**
   * Replace an object's permission list.
   *
   * This performs no authorization of its own: callers must verify ownership
   * first. Used by the screenshot gallery to publish (`anonymous:read`) or
   * withdraw an object.
   */
  async setPermissions(id: string, permissions: string[]): Promise<boolean> {
    const metadata = await this.backend.fetchMetadata(id);
    if (!metadata) return false;
    return this.backend.writeMetadata(id, { ...metadata, permissions });
  }

  /**
   * List all objects
   */
  async listAll() {
    return await this.backend.listAll();
  }

  /**
   * Purges metadata for objects that no longer exist
   * This is useful for cleaning up metadata files that are left behinds
   * @returns
   */
  async cleanupMetadata(taskLogger: pino.Logger) {
    return await this.backend.cleanupMetadata(taskLogger);
  }
}
