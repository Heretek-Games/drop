import { createReadStream } from "node:fs";
import path from "node:path";
import { getRouterParam, createError, setResponseHeader, sendStream } from "h3";
import aclManager from "~/server/internal/acls";
import pluginManager from "~/server/internal/plugins";

const MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const PUBLIC_WEB_EXTENSIONS = new Set(Object.keys(MIME_TYPES));

export default defineEventHandler(async (event) => {
  const pluginId = getRouterParam(event, "pluginId");
  const asset = getRouterParam(event, "asset");

  if (!pluginId || !asset) {
    throw createError({
      statusCode: 400,
      statusMessage: "Missing pluginId or asset path",
    });
  }

  const filePath = await pluginManager.getClientAssetPath(pluginId, asset);
  if (!filePath) {
    throw createError({
      statusCode: 404,
      statusMessage: `Plugin asset '${asset}' not found for plugin '${pluginId}'`,
    });
  }

  const ext = path.extname(filePath).toLowerCase();

  // Public web UI assets (.js, .css, images, fonts) are readable by any client,
  // including login/setup pages. Binary files and sidecars require an authenticated
  // user or client session.
  if (!PUBLIC_WEB_EXTENSIONS.has(ext)) {
    const userId = await aclManager.getUserIdACL(event, []);
    if (!userId) {
      throw createError({
        statusCode: 401,
        statusMessage:
          "Authentication required to stream plugin binary/sidecar assets",
      });
    }
  }

  const mimeType = MIME_TYPES[ext] || "application/octet-stream";

  setResponseHeader(event, "Content-Type", mimeType);
  setResponseHeader(
    event,
    "Cache-Control",
    PUBLIC_WEB_EXTENSIONS.has(ext)
      ? "public, max-age=3600"
      : "private, no-cache",
  );

  return sendStream(event, createReadStream(filePath));
});
