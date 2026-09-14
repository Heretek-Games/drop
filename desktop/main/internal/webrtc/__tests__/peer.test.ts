import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIGNALING_KINDS,
  buildSignalingMessage,
  isSignalingKind,
  toRtcIceServers,
} from "../peer";

test("isSignalingKind accepts known kinds and rejects others", () => {
  for (const kind of SIGNALING_KINDS) {
    assert.equal(isSignalingKind(kind), true);
  }
  assert.equal(isSignalingKind("bogus"), false);
  assert.equal(isSignalingKind(42), false);
});

test("buildSignalingMessage requires a payload", () => {
  assert.deepEqual(buildSignalingMessage("offer", { sdp: "v=0" }), {
    kind: "offer",
    payload: { sdp: "v=0" },
  });
  assert.throws(
    () => buildSignalingMessage("offer", undefined),
    /payload is required/,
  );
});

test("toRtcIceServers maps urls and optional credentials", () => {
  const servers = toRtcIceServers({
    iceServers: [
      { urls: ["stun:stun.example:3478"] },
      { urls: ["turn:turn.example:3478"], username: "u", credential: "c" },
    ],
  });
  assert.deepEqual(servers, [
    { urls: ["stun:stun.example:3478"] },
    { urls: ["turn:turn.example:3478"], username: "u", credential: "c" },
  ]);
  assert.deepEqual(toRtcIceServers(undefined), []);
});
