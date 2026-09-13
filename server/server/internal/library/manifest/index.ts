import cacheHandler from "../../cache";
import prisma from "../../db/database";
import type { JsonValue } from "@prisma/client/runtime/client";
import { castManifest, type V2ChunkData, type V2Manifest } from "./utils";

export type DownloadManifestDetails = {
  /***
   * Version ID to manifest
   */
  manifests: { [key: string]: V2Manifest };
  /***
   * File name to version ID
   */
  fileList: { [key: string]: string };
  /// Size on disk after download
  installSize: number;
  /// Size of download
  downloadSize: number;
};

type ManifestVersion = {
  versionId: string;
  versionIndex: number;
  delta: boolean;
  gameId: string;
  fileList: string[];
  negativeFileList: string[];
  dropletManifest: JsonValue;
};

function convertMap<T>(map: Map<string, T>): { [key: string]: T } {
  return Object.fromEntries(map.entries().toArray());
}
const manifestCache =
  cacheHandler.createCache<DownloadManifestDetails>("manifestCache");

type ManifestDeltaVersion = Omit<ManifestVersion, "gameId">;

/** Walks the delta chain backwards, newest-last, for a version. */
async function resolveVersionOrder(
  mainVersion: ManifestVersion,
): Promise<ManifestDeltaVersion[]> {
  const collectedVersions: ManifestDeltaVersion[] = [];
  let versionIndex = mainVersion.versionIndex;
  while (mainVersion.delta) {
    const nextVersion = await prisma.gameVersion.findFirst({
      where: { gameId: mainVersion.gameId, versionIndex: { lt: versionIndex } },
      orderBy: {
        versionIndex: "desc",
      },
      select: {
        versionId: true,
        versionIndex: true,
        delta: true,
        fileList: true,
        negativeFileList: true,
        dropletManifest: true,
      },
    });
    if (!nextVersion)
      throw createError({
        statusCode: 500,
        message: "Delta version without version underneath it.",
      });

    versionIndex = nextVersion.versionIndex;
    collectedVersions.push(nextVersion);
    if (!nextVersion.delta) break;
  }

  collectedVersions.reverse();
  // Apply fileList in lowest priority to newest priority
  return [...collectedVersions, mainVersion];
}

/** Applies positive/negative file lists across the version chain. */
function buildFileList(
  versionOrder: ManifestDeltaVersion[],
): Map<string, string> {
  const fileList = new Map<string, string>();
  for (const version of versionOrder) {
    for (const file of version.fileList) {
      fileList.set(file, version.versionId);
    }
    for (const negFile of version.negativeFileList) {
      fileList.delete(negFile);
    }
  }
  return fileList;
}

/**
 * Decides whether a chunk must be downloaded for this version and how many
 * install-size bytes it contributes. A file already present from the previous
 * download is skipped; a chunk is downloadable if any of its files is wanted.
 */
function classifyChunk(
  chunkData: V2ChunkData,
  versionId: string,
  fileNames: { [key: string]: string },
  existingChunks: DownloadManifestDetails | undefined,
): { download: boolean; installSize: number } {
  let download = false;
  let installSize = 0;
  for (const fileEntry of chunkData.files) {
    if (existingChunks?.fileList[fileEntry.filename] === versionId) continue;
    if (fileNames[fileEntry.filename]) {
      download = true;
      installSize += fileEntry.length;
    }
  }
  return { download, installSize };
}

/**
 *
 * @param gameId Game ID
 * @param versionId Version ID
 */
export async function createDownloadManifestDetails(
  versionId: string,
  previous?: string,
  refresh = false,
): Promise<DownloadManifestDetails> {
  const manifestKey = previous ? `${versionId}-from-${previous}` : versionId;
  if ((await manifestCache.has(manifestKey)) && !refresh)
    return (await manifestCache.get(manifestKey))!;
  const mainVersion = await prisma.gameVersion.findUnique({
    where: { versionId },
    select: {
      versionId: true,
      delta: true,
      versionIndex: true,
      fileList: true,
      negativeFileList: true,
      gameId: true,
      dropletManifest: true,
    },
  });
  if (!mainVersion)
    throw createError({ statusCode: 404, message: "Version not found" });

  const versionOrder = await resolveVersionOrder(mainVersion);
  const fileList = buildFileList(versionOrder);

  let installSize = 0;
  let downloadSize = 0;

  const existingChunks = previous
    ? await createDownloadManifestDetails(previous)
    : undefined;

  // Now that we have our file list, filter the manifests
  const manifests = new Map<string, V2Manifest>();
  for (const version of versionOrder) {
    const files = fileList
      .entries()
      .filter(([, versionId]) => version.versionId === versionId)
      .toArray();
    if (files.length == 0) continue;
    const fileNames = Object.fromEntries(files);
    const manifest = castManifest(version.dropletManifest);
    const filteredChunks = Object.fromEntries(
      Object.entries(manifest.chunks).filter(([, chunkData]) => {
        const classified = classifyChunk(
          chunkData,
          version.versionId,
          fileNames,
          existingChunks,
        );
        installSize += classified.installSize;
        if (!classified.download) return false;
        // If we have to download this chunk, add it's length
        downloadSize += chunkData.files
          .map((v) => v.length)
          .reduce((a, b) => a + b, 0);
        return true;
      }),
    );
    manifests.set(version.versionId, {
      ...manifest,
      chunks: filteredChunks,
    });
  }

  const result = {
    fileList: convertMap(fileList),
    manifests: convertMap(manifests),
    installSize,
    downloadSize,
  };
  await manifestCache.set(manifestKey, result);

  return result;
}
