import test from "node:test";
import assert from "node:assert/strict";
import { screenshotObjectPermissions } from "../permissions";

test("private screenshots grant only the owner read access", () => {
  assert.deepEqual(screenshotObjectPermissions("user-1", true), [
    "user-1:read",
  ]);
});

test("public screenshots additionally grant anonymous read", () => {
  assert.deepEqual(screenshotObjectPermissions("user-1", false), [
    "user-1:read",
    "anonymous:read",
  ]);
});
