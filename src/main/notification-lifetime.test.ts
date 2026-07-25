import assert from "node:assert/strict";
import test from "node:test";
import { retainNotification } from "./notification-lifetime";

test("releases a retained notification on the native failure path", () => {
  const notification = {};
  const active = new Set<object>();
  const failures: unknown[] = [];
  const lifetime = retainNotification(active, notification, (error) => {
    failures.push(error);
  });
  assert.equal(active.has(notification), true);

  lifetime.fail("native failure");

  assert.equal(active.has(notification), false);
  assert.deepEqual(failures, ["native failure"]);
});

test("release is idempotent and failure cleanup survives logger errors", () => {
  const notification = {};
  const active = new Set<object>();
  const lifetime = retainNotification(active, notification, () => {
    throw new Error("logger failed");
  });

  assert.doesNotThrow(() => lifetime.fail("native failure"));
  assert.doesNotThrow(() => lifetime.release());
  assert.equal(active.size, 0);
});
