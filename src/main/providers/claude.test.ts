import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeQuotaProvider } from "./claude";

test("maps valid Claude cache windows and preserves capturedAt", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-claude-provider-"),
  );
  const cachePath = path.join(directory, "cache.json");
  try {
    await fs.promises.writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        capturedAt: 1_799_999_900,
        fiveHour: { usedPercent: 54, resetsAt: 1_800_000_000 },
        sevenDay: { usedPercent: 12, resetsAt: 1_800_604_800 },
      }),
    );
    const snapshot = await new ClaudeQuotaProvider(cachePath).readQuota();
    assert.deepEqual(snapshot, {
      providerId: "claude",
      connectionState: "connected",
      capturedAt: 1_799_999_900,
      windows: [
        {
          label: "Five hours",
          usedPercent: 54,
          windowMinutes: 300,
          resetsAt: 1_800_000_000,
        },
        {
          label: "Weekly",
          usedPercent: 12,
          windowMinutes: 10_080,
          resetsAt: 1_800_604_800,
        },
      ],
    });
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("missing cache is no-data-yet rather than unsupported or zero", async () => {
  const snapshot = await new ClaudeQuotaProvider(
    path.join(os.tmpdir(), `aum-missing-${process.pid}-${Date.now()}.json`),
    () => 1_800_000_000_000,
  ).readQuota();
  assert.equal(snapshot.connectionState, "no-data-yet");
  assert.deepEqual(snapshot.windows, []);
  assert.equal(snapshot.capturedAt, 1_800_000_000);
});

test("corrupt and incompatible caches return a named safe error", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-claude-corrupt-"),
  );
  const cachePath = path.join(directory, "cache.json");
  try {
    for (const contents of [
      "{",
      JSON.stringify({
        version: 9,
        capturedAt: 1,
        fiveHour: { usedPercent: 0, resetsAt: 1 },
      }),
    ]) {
      await fs.promises.writeFile(cachePath, contents);
      const snapshot = await new ClaudeQuotaProvider(
        cachePath,
        () => 2_000,
      ).readQuota();
      assert.equal(snapshot.connectionState, "error");
      assert.deepEqual(snapshot.windows, []);
      assert.equal(
        snapshot.error,
        "Claude usage cache is unavailable or incompatible.",
      );
      assert.equal(snapshot.error?.includes(cachePath), false);
    }
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
