import test from "node:test";
import assert from "node:assert/strict";
import { scanInstalledDir } from "../install-scan";

test("scanInstalledDir ranks the real game binary extracted by an installer", () => {
  const files = [
    "GameName.exe",
    "Code/GameName-Win64-Shipping.exe",
    "Redist/vcredist_x64.exe",
    "Support/unins000.exe",
    "setup.exe",
  ];

  const result = scanInstalledDir(files, "GameName");

  assert.equal(result.scannedCount, 5);
  assert.ok(result.candidates.length > 0);
  assert.equal(result.candidates[0].isPrimary, true);
  assert.ok(
    result.candidates.some(
      (c) => c.path === "Code/GameName-Win64-Shipping.exe",
    ),
  );
  assert.ok(!result.candidates.some((c) => c.path.endsWith("setup.exe")));
  assert.ok(!result.candidates.some((c) => c.path.includes("vcredist")));
});

test("scanInstalledDir reports empty results for install dirs without game exes", () => {
  const files = ["readme.txt", "setup.exe", "unins000.exe"];

  const result = scanInstalledDir(files, "Totally Unknown Game");

  assert.equal(result.scannedCount, 3);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.skippedCount, 3);
});
