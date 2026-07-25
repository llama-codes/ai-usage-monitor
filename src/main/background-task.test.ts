import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundTaskScheduler } from "./background-task";

test("terminally catches asynchronous and synchronous background failures", async () => {
  const errors: unknown[] = [];
  const scheduler = new BackgroundTaskScheduler((error) => errors.push(error));

  await scheduler.run(() => {
    throw new Error("sync");
  });
  await scheduler.run(async () => {
    throw new Error("async");
  });

  assert.deepEqual(
    errors.map((error) => (error as Error).message),
    ["sync", "async"],
  );
});

test("does not reject if the background failure logger itself throws", async () => {
  const scheduler = new BackgroundTaskScheduler(() => {
    throw new Error("logger failed");
  });

  await assert.doesNotReject(
    scheduler.run(async () => {
      throw new Error("task failed");
    }),
  );
});

test("resume follow-up starts only after the captured active task settles", async () => {
  const events: string[] = [];
  let settleActive: (() => void) | undefined;
  const active = new Promise<void>((resolve) => {
    settleActive = resolve;
  });
  const scheduler = new BackgroundTaskScheduler(() => undefined);

  const followUp = scheduler.runAfterSettled(active, () => {
    events.push("follow-up");
  });
  await Promise.resolve();
  assert.equal(events.length, 0);

  events.push("active-settled");
  settleActive?.();
  await followUp;
  assert.deepEqual(events, ["active-settled", "follow-up"]);
});

test("resume follow-up still runs after a captured active task rejects", async () => {
  const events: string[] = [];
  const scheduler = new BackgroundTaskScheduler(() => undefined);

  await scheduler.runAfterSettled(Promise.reject(new Error("sleep")), () => {
    events.push("post-resume-read");
  });

  assert.deepEqual(events, ["post-resume-read"]);
});
