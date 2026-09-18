import {
  VersionQuerySchema,
  VersionResponse_LibrarySource_LibraryBackend,
  VersionResponse_LibrarySourceSchema,
  VersionResponse_Manifest_ChunkData_FileEntrySchema,
  VersionResponse_Manifest_ChunkDataSchema,
  VersionResponse_ManifestSchema,
  VersionResponseSchema,
} from "../../proto/torrential/proto/version_pb";
import { castManifest } from "../../library/manifest/utils";
import { LibraryBackend } from "~/prisma/client/client";
import { create, fromBinary } from "@bufbuild/protobuf";
import prisma from "../../db/database";
import { defineQueryProcessor } from "./utils";
import {
  DropBoundType,
  TorrentialBoundType,
} from "../../proto/torrential/proto/core_pb";
import { resolveRemoteDepot } from "../depot/remote";
import { getTorrentialRpcSecret, INTERNAL_DEPOT_URL } from "./index";

export default defineQueryProcessor({
  queryType: DropBoundType.VERSION_QUERY,
  run: async (query) => {
    const queryData = fromBinary(VersionQuerySchema, query.data);

    const version = await prisma.gameVersion.findUnique({
      where: {
        versionId: queryData.versionId,
      },
      select: {
        gameId: true,
        versionId: true,
        dropletManifest: true,
        versionPath: true,
        game: {
          select: {
            library: true,
            libraryPath: true,
          },
        },
      },
    });
    if (!version) throw new Error("Game version not found");

    const manifest = castManifest(version.dropletManifest);

    const sourceOptions: Record<string, unknown> = {
      ...(typeof version.game.library.options === "object" &&
      version.game.library.options !== null
        ? (version.game.library.options as Record<string, unknown>)
        : {}),
    };

    const remoteDepot = await resolveRemoteDepot(
      version.gameId,
      version.versionId,
    );
    if (remoteDepot) {
      if (remoteDepot.stream.pieceReader || !remoteDepot.stream.url) {
        sourceOptions.remoteUrl = `${INTERNAL_DEPOT_URL.origin}/api/v1/internal/depot/${version.gameId}/${version.versionId}/range`;
        sourceOptions.remoteHeaders = {
          "x-torrential-secret": getTorrentialRpcSecret(),
        };
      } else {
        sourceOptions.remoteUrl = remoteDepot.stream.url;
        sourceOptions.remoteHeaders = remoteDepot.stream.headers ?? {};
      }
    }

    const mapEnum = (v: LibraryBackend) => {
      switch (v) {
        case LibraryBackend.Filesystem:
          return VersionResponse_LibrarySource_LibraryBackend.FILESYSTEM;
        case LibraryBackend.FlatFilesystem:
          return VersionResponse_LibrarySource_LibraryBackend.FLAT_FILESYSTEM;
      }
    };

    return {
      type: TorrentialBoundType.VERSION_RESPONSE,
      schema: VersionResponseSchema,
      data: create(VersionResponseSchema, {
        manifest: create(VersionResponse_ManifestSchema, {
          version: manifest.version,
          size: BigInt(manifest.size),
          key: Buffer.from(manifest.key),
          chunks: Object.fromEntries(
            Object.entries(manifest.chunks).map(([id, chunk]) => [
              id,
              create(VersionResponse_Manifest_ChunkDataSchema, {
                checksum: chunk.checksum,
                iv: Buffer.from(chunk.iv),
                files: chunk.files.map((file) =>
                  create(VersionResponse_Manifest_ChunkData_FileEntrySchema, {
                    filename: file.filename,
                    start: BigInt(file.start),
                    length: BigInt(file.length),
                    permissions: file.permissions,
                  }),
                ),
              }),
            ]),
          ),
        }),
        source: create(VersionResponse_LibrarySourceSchema, {
          options: JSON.stringify(sourceOptions),
          id: version.game.library.id,
          backend: mapEnum(version.game.library.backend),
        }),
        libraryPath: version.game.libraryPath,
        versionPath: version.versionPath ?? "",
      }),
    };
  },
});
