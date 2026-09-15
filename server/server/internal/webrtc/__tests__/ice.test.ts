import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TURN_TTL_SECONDS,
  buildIceConfig,
  parseUrlList,
  turnCredentials,
} from "../ice";

test("parseUrlList splits comma/whitespace lists", () => {
  assert.deepEqual(parseUrlList("stun:a, stun:b\nstun:c"), [
    "stun:a",
    "stun:b",
    "stun:c",
  ]);
  assert.deepEqual(parseUrlList(undefined), []);
});

test("buildIceConfig returns STUN only when TURN is unconfigured", () => {
  const config = buildIceConfig(
    { stunUrls: "stun:stun.example:3478" },
    "user-1",
    0,
  );
  assert.deepEqual(config, {
    iceServers: [{ urls: ["stun:stun.example:3478"] }],
  });
  assert.equal(config.expiresAt, undefined);
});

test("buildIceConfig issues ephemeral TURN credentials", () => {
  const now = 1_700_000_000_000;
  const config = buildIceConfig(
    {
      stunUrls: "stun:s1",
      turnUrls: "turn:t1, turn:t2",
      turnSecret: "secret",
    },
    "user-1",
    now,
  );

  assert.equal(config.iceServers.length, 2);
  const turn = config.iceServers[1]!;
  assert.deepEqual(turn.urls, ["turn:t1", "turn:t2"]);

  const expirySeconds = Math.floor(now / 1000) + DEFAULT_TURN_TTL_SECONDS;
  const expectedUsername = `${expirySeconds}:user-1`;
  assert.equal(turn.username, expectedUsername);
  // Fixed vector: base64(HMAC-SHA1("secret", "1700003600:user-1")).
  const expectedDigest = "CEsUJR7O3T8zA48LhdKXvRodkuQ=";
  assert.equal(turn.credential, expectedDigest);
  assert.equal(config.expiresAt, expirySeconds * 1000);
});

test("TURN without a secret is omitted", () => {
  const config = buildIceConfig({ turnUrls: "turn:t1" }, "user-1");
  assert.deepEqual(config, { iceServers: [] });
});

test("turnCredentials honours a custom ttl and a one-second minimum", () => {
  assert.equal(turnCredentials("s", "u", 120, 0).username, "120:u");
  assert.equal(turnCredentials("s", "u", 0, 0).username, "1:u");
});
