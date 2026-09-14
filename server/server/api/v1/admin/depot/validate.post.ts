import { type } from "arktype";
import { readDropValidatedBody, throwingArktype } from "~/server/arktype";
import aclManager from "~/server/internal/acls";

const ValidateDepot = type({
  endpoint: "string",
}).configure(throwingArktype);

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Probes an admin-supplied depot endpoint before it is registered.
 *
 * The endpoint is treated as an SSRF-sensitive value: only `http`/`https` URLs
 * are allowed, the request carries a short timeout, and only the depot's
 * `speedtest` object is fetched — never an operator-provided path.
 */
export default defineEventHandler(async (h3) => {
  const allowed = await aclManager.allowSystemACL(h3, ["depot:read"]);
  if (!allowed) throw createError({ statusCode: 403 });

  const body = await readDropValidatedBody(h3, ValidateDepot);

  let parsed: URL;
  try {
    parsed = new URL(body.endpoint);
  } catch {
    throw createError({
      statusCode: 400,
      message: "endpoint is not a valid URL",
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createError({
      statusCode: 400,
      message: "endpoint must use http or https",
    });
  }

  const base = body.endpoint.endsWith("/")
    ? body.endpoint
    : `${body.endpoint}/`;
  const startedAt = Date.now();
  try {
    const response = await fetch(`${base}speedtest`, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return {
      reachable: response.ok,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      error: response.ok
        ? undefined
        : `depot responded with ${response.status}`,
    };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
});
