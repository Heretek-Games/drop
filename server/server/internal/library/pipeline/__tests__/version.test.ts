import test from "node:test";
import assert from "node:assert/strict";
import { compareVersionHints, parseVersionHint } from "../version";
import {
  matchPatchToBaseVersion,
  type BaseVersionCandidate,
} from "../version-matcher";

test("parseVersionHint reads dotted release versions", () => {
  assert.equal(
    parseVersionHint("Grand.Theft.Auto.V.Enhanced.Update.v1.0.889.22-RUNE"),
    "1.0.889.22",
  );
  assert.equal(
    parseVersionHint("James_Bond_007_Nightfire_Update_1.1-FLTDOX"),
    "1.1",
  );
  assert.equal(
    parseVersionHint("A Short Hike_1.10.1_patched_(85628)"),
    "1.10.1",
  );
});

test("parseVersionHint reads ISO-style dates", () => {
  assert.equal(
    parseVersionHint("Metro Awakening v2026-01-14.7z"),
    "2026.01.14",
  );
});

test("parseVersionHint returns undefined for plain release names", () => {
  assert.equal(parseVersionHint("Grand.Theft.Auto.V-RUNE"), undefined);
  assert.equal(parseVersionHint("DEViANCE"), undefined);
});

test("compareVersionHints orders numeric and date hints", () => {
  assert.ok(compareVersionHints("1.10.1", "1.2") > 0);
  assert.ok(compareVersionHints("1.0.889.22", "1.0.889.21") > 0);
  assert.ok(compareVersionHints("1.1", "1.10.1") < 0);
  assert.ok(compareVersionHints("2026.01.14", "2025.12.31") > 0);
  assert.equal(compareVersionHints(undefined, "1.0"), -1);
  assert.equal(compareVersionHints(undefined, undefined), 0);
});

const bases: BaseVersionCandidate[] = [
  {
    versionId: "older",
    versionPath: "Some Game v1.0 ((__SERVER__))",
    delta: false,
  },
  {
    versionId: "newer",
    versionPath: "Some Game v1.5",
    delta: false,
  },
  { versionId: "delta", versionPath: "Some Game Update v1.6", delta: true },
];

test("matchPatchToBaseVersion picks the newest predecessor bake", () => {
  const match = matchPatchToBaseVersion("1.6", bases, ["newer", "older"]);
  assert.ok(match);
  assert.equal(match?.versionId, "newer");
});

test("matchPatchToBaseVersion falls back to the newest version without hints", () => {
  const noHints: BaseVersionCandidate[] = [
    { versionId: "base", versionPath: "Some Game-RUNE", delta: false },
  ];
  const match = matchPatchToBaseVersion(undefined, noHints, ["base"]);
  assert.ok(match);
  assert.equal(match?.versionId, "base");
});

test("matchPatchToBaseVersion ignores delta versions as bases", () => {
  const onlyDelta: BaseVersionCandidate[] = [bases[2]];
  assert.equal(matchPatchToBaseVersion("1.7", onlyDelta, ["delta"]), undefined);
});
