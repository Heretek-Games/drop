import type { JsonValue } from "@prisma/client/runtime/client";

export type V2Manifest = {
  version: "2";
  size: number;
  key: number[];
  chunks: { [key: string]: V2ChunkData };
};

export type V2ChunkData = {
  files: Array<V2FileEntry>;
  checksum: string;
  iv: number[];
};

export type V2FileEntry = {
  filename: string;
  start: number;
  length: number;
  permissions: number;
};

export function castManifest(manifest: JsonValue): V2Manifest {
  // Local manifests were historically stored as JSON strings, while depot
  // manifests (and anything written after the recipe was embedded) are JSONB
  // objects returned by Prisma. Accept both shapes.
  return (
    typeof manifest === "string" ? JSON.parse(manifest) : manifest
  ) as V2Manifest;
}
