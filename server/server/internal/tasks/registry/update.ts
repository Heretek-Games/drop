import { type } from "arktype";
import type pino from "pino";
import * as semver from "semver";
import { defineDropTask } from "..";
import cacheHandler from "../../cache";
import { systemConfig } from "../../config/sys-conf";
import notificationSystem from "../../notifications";

const latestRelease = type({
  url: "string", // api url for specific release
  html_url: "string", // user facing url
  id: "number", // release id
  tag_name: "string", // tag used for release
  name: "string", // release name
  draft: "boolean",
  prerelease: "boolean",
  created_at: "string",
  published_at: "string",
});

const UPDATE_CHECK_URL =
  "https://api.github.com/repos/Drop-OSS/drop/releases/latest";
const UPDATE_CHECK_CACHE_KEY = "latest-release";
type CachedRelease = { etag: string; release: Record<string, unknown> };
const updateCheckCache = cacheHandler.createCache<CachedRelease>("UpdateCheck");

function isRateLimited(response: Response) {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return response.headers.get("x-ratelimit-remaining") === "0";
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // Authenticated requests get a much higher rate limit; the token is optional
  // so self-hosted instances without one still work.
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

type FetchReleaseResult =
  | { status: "release"; release: unknown }
  | { status: "rate-limited"; resetAt: string };

async function fetchLatestRelease(
  logger: pino.Logger,
): Promise<FetchReleaseResult> {
  const headers = githubHeaders();
  const cached = await updateCheckCache.get(UPDATE_CHECK_CACHE_KEY);
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  const response = await fetch(UPDATE_CHECK_URL, { headers });

  if (response.status === 304) {
    // Conditional request: the release has not changed since the last check.
    if (!cached?.release) {
      throw new Error(
        "GitHub returned 304 Not Modified but no cached release is available",
      );
    }
    return { status: "release", release: cached.release };
  }

  if (response.ok) {
    const release = await response.json();
    const etag = response.headers.get("etag");
    if (etag) {
      await updateCheckCache.set(UPDATE_CHECK_CACHE_KEY, {
        etag,
        release: release as CachedRelease["release"],
      });
    }
    return { status: "release", release };
  }

  if (isRateLimited(response)) {
    // A crashloop or shared egress IP can exhaust the anonymous quota; this
    // is transient, so callers log an actionable warning instead of failing.
    const reset = response.headers.get("x-ratelimit-reset");
    const resetAt = reset
      ? new Date(Number.parseInt(reset, 10) * 1000).toISOString()
      : "unknown";
    return { status: "rate-limited", resetAt };
  }

  const errorBody = await response.text().catch(() => "");
  logger.info(
    { status: response.status, body: errorBody },
    "Failed to check for update ",
  );
  throw new Error(
    `Failed to check for update: ${response.status} ${errorBody}`,
  );
}

export default defineDropTask({
  buildId: () => `check:update:${new Date().toISOString()}`,
  name: "Check for Update",
  acls: ["system:maintenance:read"],
  taskGroup: "check:update",
  async run({ progress, logger }) {
    if (!systemConfig.shouldCheckForUpdates()) {
      logger.info("Update check is disabled by configuration");
      progress(100);
      return;
    }

    logger.info("Checking for update");

    const currVerStr = systemConfig.getDropVersion();
    const currVer = semver.coerce(currVerStr);
    if (currVer === null) {
      const msg = "Drop provided a invalid semver tag";
      logger.info(msg);
      throw new Error(msg);
    }
    progress(30);

    const result = await fetchLatestRelease(logger);
    progress(50);

    if (result.status === "rate-limited") {
      logger.warn(
        { resetAt: result.resetAt },
        "GitHub API rate limit hit; set GITHUB_TOKEN to raise the limit",
      );
      progress(100);
      return;
    }

    const releaseJson = result.release;

    // parse and validate response
    const body = latestRelease(releaseJson);
    if (body instanceof type.errors) {
      logger.info(body.summary);
      logger.info("GitHub Api response" + JSON.stringify(releaseJson));
      throw new Error(
        `GitHub Api response did not match expected schema: ${body.summary}`,
      );
    }

    // parse remote version
    const latestVer = semver.coerce(body.tag_name);
    if (latestVer === null) {
      const msg = "Github Api returned invalid semver tag";
      logger.info(msg);
      throw new Error(msg);
    }
    progress(70);

    // TODO: handle prerelease identifiers https://github.com/npm/node-semver#prerelease-identifiers
    // check if is newer version
    if (semver.gt(latestVer, currVer)) {
      logger.info("Update available");
      notificationSystem.systemPush({
        nonce: `drop-update-available-${currVer}-to-${latestVer}`,
        title: `Update available to v${latestVer}`,
        description: `A new version of Drop is available v${latestVer}`,
        actions: [`View|${body.html_url}`],
        acls: ["system:notifications:read"],
      });
    } else {
      logger.info("no update available");
    }

    logger.info("Done");
    progress(100);
  },
});
