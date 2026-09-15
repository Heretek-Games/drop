import { createHmac } from "node:crypto";

/**
 * WebRTC ICE server configuration (#19 zero-config multiplayer).
 *
 * Clients need STUN/TURN servers to traverse NATs. STUN URLs are static; TURN
 * uses coturn's time-limited credential REST API: the username encodes an
 * expiry and the credential is an HMAC over that username, so no long-lived
 * secret leaves the server.
 */

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceConfig {
  iceServers: IceServer[];
  /** Unix epoch (ms) at which the TURN credentials expire. */
  expiresAt?: number;
}

export interface IceEnv {
  stunUrls?: string;
  turnUrls?: string;
  turnSecret?: string;
  turnTtlSeconds?: number;
}

export const DEFAULT_TURN_TTL_SECONDS = 3600;

/** Split a comma/whitespace separated URL list. */
export function parseUrlList(value?: string): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** coturn REST-API ephemeral credentials for one user. */
export function turnCredentials(
  secret: string,
  userId: string,
  ttlSeconds: number,
  nowMs: number,
): { username: string; credential: string; expiresAt: number } {
  const expiry = Math.floor(nowMs / 1000) + Math.max(1, Math.floor(ttlSeconds));
  const username = `${expiry}:${userId}`;
  // coturn's TURN REST API mandates HMAC-SHA1 here
  // (draft-uberti-behave-turn-rest-00; coturn only validates SHA-1, see
  // coturn/coturn#1293). SHA-1's collision attacks do not apply to HMAC
  // preimages, and the credential expires after a short TTL.
  const credential = createHmac("sha1", secret)
    .update(username)
    .digest("base64");
  return { username, credential, expiresAt: expiry * 1000 };
}

/**
 * Build the ICE configuration for one user. TURN is only offered when both a
 * URL list and a shared secret are configured (otherwise the credentials would
 * be unusable).
 */
export function buildIceConfig(
  env: IceEnv,
  userId: string,
  nowMs: number = Date.now(),
): IceConfig {
  const iceServers: IceServer[] = [];

  const stun = parseUrlList(env.stunUrls);
  if (stun.length > 0) {
    iceServers.push({ urls: stun });
  }

  const turn = parseUrlList(env.turnUrls);
  const ttl =
    typeof env.turnTtlSeconds === "number" &&
    Number.isFinite(env.turnTtlSeconds) &&
    env.turnTtlSeconds > 0
      ? env.turnTtlSeconds
      : DEFAULT_TURN_TTL_SECONDS;

  if (turn.length > 0 && env.turnSecret) {
    const credentials = turnCredentials(env.turnSecret, userId, ttl, nowMs);
    iceServers.push({
      urls: turn,
      username: credentials.username,
      credential: credentials.credential,
    });
    return { iceServers, expiresAt: credentials.expiresAt };
  }

  return { iceServers };
}
