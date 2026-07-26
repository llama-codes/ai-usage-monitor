import assert from "node:assert/strict";
import test from "node:test";
import {
  isForceRefreshRequest,
  isInstallClaudeHookRequest,
  isQuitRequestArguments,
  isQuotaSnapshot,
  QUOTA_WINDOW_MINUTES,
  type QuotaSnapshot,
} from "./contracts";

test("accepts the exact forced-refresh payload", () => {
  assert.equal(isForceRefreshRequest({ reason: "user" }), true);
  assert.equal(isForceRefreshRequest({}), false);
  assert.equal(isForceRefreshRequest({ reason: "timer" }), false);
  assert.equal(
    isForceRefreshRequest({ reason: "user", unexpected: true }),
    false,
  );
});

test("accepts only an exact no-payload quit request", () => {
  assert.equal(isQuitRequestArguments([]), true);
  assert.equal(isQuitRequestArguments([undefined]), false);
  assert.equal(isQuitRequestArguments([{}]), false);
});

test("accepts only an explicitly confirmed Claude hook install", () => {
  assert.equal(isInstallClaudeHookRequest({ confirmed: true }), true);
  assert.equal(isInstallClaudeHookRequest({}), false);
  assert.equal(isInstallClaudeHookRequest({ confirmed: false }), false);
  assert.equal(
    isInstallClaudeHookRequest({ confirmed: true, unexpected: true }),
    false,
  );
});

test("accepts valid quota snapshots and duration IDs", () => {
  const snapshot: QuotaSnapshot = {
    providerId: "example",
    connectionState: "connected",
    windows: [
      {
        label: "Five hours",
        usedPercent: 42.5,
        windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
        resetsAt: 1_800_000_000,
      },
      {
        label: "Weekly",
        usedPercent: 10,
        windowMinutes: QUOTA_WINDOW_MINUTES.weekly,
        resetsAt: 1_800_604_800,
      },
    ],
    capturedAt: 1_799_999_900,
  };

  assert.equal(isQuotaSnapshot(snapshot), true);
});

test("allows absent windows for supported providers not yet connected", () => {
  assert.equal(
    isQuotaSnapshot({
      providerId: "example",
      connectionState: "not-connected",
      windows: [],
      capturedAt: 1_799_999_900,
      error: "Provider integration is not implemented.",
    }),
    true,
  );
});

test("distinguishes no-data and safe provider errors", () => {
  for (const connectionState of ["no-data-yet", "error"]) {
    assert.equal(
      isQuotaSnapshot({
        providerId: "claude",
        connectionState,
        windows: [],
        capturedAt: 1_799_999_900,
        error: "Safe provider state.",
      }),
      true,
    );
  }
});

test("represents unsupported providers without manufacturing usage", () => {
  assert.equal(
    isQuotaSnapshot({
      providerId: "opencode",
      connectionState: "unsupported",
      windows: [],
      capturedAt: 1_799_999_900,
      error: "Provider is not supported.",
    }),
    true,
  );
});

test("rejects invalid percentages, durations, and timestamps", () => {
  const base = {
    providerId: "example",
    connectionState: "connected",
    capturedAt: 1_799_999_900,
  };

  for (const window of [
    {
      label: "Five hours",
      usedPercent: -1,
      windowMinutes: 300,
      resetsAt: 1_800_000_000,
    },
    {
      label: "Five hours",
      usedPercent: 101,
      windowMinutes: 300,
      resetsAt: 1_800_000_000,
    },
    {
      label: "Daily",
      usedPercent: 50,
      windowMinutes: 1_440,
      resetsAt: 1_800_000_000,
    },
    {
      label: "Five hours",
      usedPercent: 50,
      windowMinutes: 300,
      resetsAt: 1_800_000_000.5,
    },
  ]) {
    assert.equal(isQuotaSnapshot({ ...base, windows: [window] }), false);
  }
});
