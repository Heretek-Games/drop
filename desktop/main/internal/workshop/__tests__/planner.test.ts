import { test } from "node:test";
import assert from "node:assert/strict";
import { planModLoad, type ModManifest } from "../planner";

function mod(
  id: string,
  dependencies: string[] = [],
  files: string[] = [],
): ModManifest {
  return {
    id,
    name: id,
    version: "1.0.0",
    dependencies: dependencies.map((dependency) => ({ id: dependency })),
    files,
  };
}

test("orders dependencies before dependents", () => {
  const plan = planModLoad([mod("pack", ["lib"]), mod("lib"), mod("extra")]);
  assert.deepEqual(plan.order, ["extra", "lib", "pack"]);
  assert.deepEqual(plan.missing, []);
});

test("reports missing dependencies without failing", () => {
  const plan = planModLoad([mod("pack", ["lib", "missing"])]);
  assert.deepEqual(plan.missing, ["lib", "missing"]);
  assert.deepEqual(plan.order, ["pack"]);
});

test("throws on a dependency cycle", () => {
  assert.throws(() => planModLoad([mod("a", ["b"]), mod("b", ["a"])]), /cycle/);
});

test("detects shared file paths as conflicts", () => {
  const plan = planModLoad([
    mod("a", [], ["shared.pak", "a.pak"]),
    mod("b", [], ["shared.pak"]),
  ]);
  assert.deepEqual(plan.conflicts, [{ path: "shared.pak", mods: ["a", "b"] }]);
});

test("no conflicts when files are disjoint", () => {
  const plan = planModLoad([mod("a", [], ["a.pak"]), mod("b", [], ["b.pak"])]);
  assert.deepEqual(plan.conflicts, []);
});
