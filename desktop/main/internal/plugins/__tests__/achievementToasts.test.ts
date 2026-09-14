import test from "node:test";
import assert from "node:assert/strict";
import { dismissToast, enqueueToast, expireToasts } from "../achievementToasts";

test("enqueueToast adds an unlock and deduplicates by key", () => {
  const first = enqueueToast(
    [],
    { key: "ra:1", title: "First", points: 5 },
    100,
  );
  assert.equal(first.length, 1);
  assert.equal(first[0].title, "First");

  const duplicate = enqueueToast(first, { key: "ra:1", title: "First" }, 200);
  assert.equal(duplicate.length, 1);
});

test("dismissToast removes a toast by id", () => {
  const queue = enqueueToast([], { key: "a", title: "A" }, 0);
  const { id } = queue[0];
  assert.equal(dismissToast(queue, id).length, 0);
  assert.equal(dismissToast(queue, "missing").length, 1);
});

test("expireToasts drops stale entries", () => {
  const queue = enqueueToast([], { key: "a", title: "A" }, 0);
  assert.equal(expireToasts(queue, 500, 1000).length, 1);
  assert.equal(expireToasts(queue, 1500, 1000).length, 0);
});
