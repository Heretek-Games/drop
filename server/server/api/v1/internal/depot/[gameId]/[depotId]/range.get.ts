import {
  createError,
  defineEventHandler,
  getHeader,
  getQuery,
  getRequestIP,
  getRouterParam,
  setResponseHeader,
  setResponseStatus,
  type H3Event,
} from "h3";
import {
  readRemoteRange,
  resolveRemoteDepot,
} from "~/server/internal/services/depot/remote";
import { verifyTorrentialRpcSecret } from "~/server/internal/services/torrential";

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "localhost"
  );
}

/**
 * Rejects callers that do not present a valid TORRENTIAL_RPC_SECRET or that
 * connect from a non-loopback address.
 */
function assertBridgeAccess(event: H3Event): void {
  const secret = getHeader(event, "x-torrential-secret");
  if (!verifyTorrentialRpcSecret(secret)) {
    throw createError({
      statusCode: 401,
      statusMessage: "Unauthorized bridge access",
    });
  }

  const directIp = event.node.req.socket.remoteAddress;
  const reqIp = getRequestIP(event, { xForwardedFor: false });
  if (!isLoopback(directIp) && !isLoopback(reqIp)) {
    throw createError({
      statusCode: 403,
      statusMessage: "Loopback peers only",
    });
  }
}

/** Reads offset/length from explicit query parameters. */
function parseQueryRange(event: H3Event): { offset: number; length: number } {
  const query = getQuery(event);
  return {
    offset: Number(query.offset),
    length: Number(query.length),
  };
}

/**
 * Parses the `Range: bytes=...` header into an offset/length pair, or returns
 * `null` when the request carries no Range header.
 */
function parseRangeHeader(
  event: H3Event,
): { offset: number; length: number } | null {
  const rangeHeader = getHeader(event, "range");
  if (!rangeHeader) return null;

  const match = /^bytes=(\d+)-(\d+)?$/i.exec(rangeHeader.trim());
  if (!match) {
    throw createError({
      statusCode: 400,
      statusMessage: "Malformed Range header",
    });
  }

  const offset = Number.parseInt(match[1], 10);
  if (match[2] !== undefined) {
    const end = Number.parseInt(match[2], 10);
    if (end < offset) {
      throw createError({
        statusCode: 416,
        statusMessage: "Range end precedes start",
      });
    }
    return { offset, length: end - offset + 1 };
  }

  const query = getQuery(event);
  const length = query.length ? Number(query.length) : 0;
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw createError({
      statusCode: 400,
      statusMessage: "Open-ended Range requires a positive length parameter",
    });
  }
  return { offset, length };
}

function assertValidRange(offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw createError({
      statusCode: 400,
      statusMessage: "offset must be a non-negative integer",
    });
  }
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw createError({
      statusCode: 400,
      statusMessage: "length must be a positive integer",
    });
  }
}

/**
 * Parses the requested byte range from the Range header, falling back to
 * explicit offset/length query parameters.
 */
function parseDepotRange(event: H3Event): { offset: number; length: number } {
  const range = parseRangeHeader(event) ?? parseQueryRange(event);
  assertValidRange(range.offset, range.length);
  return range;
}

/**
 * Localhost-only byte-range bridge for remote depot streams.
 *
 * Allows the Rust torrential process to fetch byte ranges from providers that
 * expose process-local callbacks (pieceReader) or remote HTTP range endpoints.
 * Authenticated strictly with TORRENTIAL_RPC_SECRET and rejected from non-loopback
 * peers.
 */
export default defineEventHandler(async (event) => {
  assertBridgeAccess(event);

  const gameId = getRouterParam(event, "gameId");
  const depotId = getRouterParam(event, "depotId");
  if (!gameId || !depotId) {
    throw createError({
      statusCode: 400,
      statusMessage: "Missing gameId or depotId",
    });
  }

  const { offset, length } = parseDepotRange(event);

  const resolved = await resolveRemoteDepot(gameId, depotId);
  if (!resolved) {
    throw createError({
      statusCode: 404,
      statusMessage: `No remote depot provider available for game ${gameId} / depot ${depotId}`,
    });
  }

  const chunk = await readRemoteRange(resolved.stream, offset, length);

  setResponseStatus(event, 206);
  setResponseHeader(event, "Content-Type", "application/octet-stream");
  setResponseHeader(event, "Accept-Ranges", "bytes");
  setResponseHeader(event, "Content-Length", chunk.byteLength);
  setResponseHeader(
    event,
    "Content-Range",
    `bytes ${offset}-${offset + chunk.byteLength - 1}/*`,
  );
  return Buffer.from(chunk);
});
