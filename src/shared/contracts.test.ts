import assert from "node:assert/strict";
import test from "node:test";
import {
  isForceRefreshRequest,
  isInstallClaudeHookRequest,
  isQuitRequestArguments,
  isQuotaReport,
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

test("strictly validates quota reports and every forecast state", () => {
  const snapshot: QuotaSnapshot = {
    providerId: "codex",
    connectionState: "connected",
    capturedAt: 1_800_000_000,
    windows: [
      {
        label: "Five hours",
        usedPercent: 50,
        windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
        resetsAt: 1_800_010_000,
      },
    ],
  };
  const evidence = {
    sampleCount: 10,
    distinctCaptureCount: 10,
    spanSeconds: 3_600,
    increasePercent: 10,
  };
  const emptyEvidence = {
    sampleCount: 0,
    distinctCaptureCount: 0,
    spanSeconds: 0,
    increasePercent: 0,
  };
  const base = {
    providerId: "codex",
    windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
    resetsAt: 1_800_010_000,
    evidence,
  };
  const provenance = {
    calculatedAt: 1_800_000_000,
    evidenceStartAt: 1_799_996_400,
    evidenceEndAt: 1_800_000_000,
  };
  const forecasts = [
    { ...base, state: "insufficient" },
    { ...base, state: "stale-paused", evidence: emptyEvidence },
    {
      ...base,
      state: "stale-paused",
      evidence: emptyEvidence,
      retainedEstimate: {
        state: "projected-runout",
        confidence: "high",
        ...provenance,
        projectedRunoutAt: 1_800_005_000,
        evidence,
      },
    },
    {
      ...base,
      state: "safe-through-reset",
      confidence: "medium",
      ...provenance,
    },
    {
      ...base,
      state: "projected-runout",
      confidence: "high",
      ...provenance,
      projectedRunoutAt: 1_800_005_000,
    },
    {
      ...base,
      state: "exhausted",
      calculatedAt: 1_800_000_000,
      evidence: emptyEvidence,
    },
    { ...base, state: "unavailable-error", evidence: emptyEvidence },
  ];
  for (const forecast of forecasts) {
    const matchingSnapshot =
      forecast.state === "exhausted"
        ? {
            ...snapshot,
            windows: snapshot.windows.map((window) => ({
              ...window,
              usedPercent: 100,
            })),
          }
        : snapshot;
    assert.equal(
      isQuotaReport({
        snapshots: [matchingSnapshot],
        forecasts: [forecast],
      }),
      true,
    );
  }
  for (const usedPercent of [50, 99.99]) {
    assert.equal(
      isQuotaReport({
        snapshots: [
          {
            ...snapshot,
            windows: snapshot.windows.map((window) => ({
              ...window,
              usedPercent,
            })),
          },
        ],
        forecasts: [forecasts[5]],
      }),
      false,
    );
  }
  assert.equal(
    isQuotaReport({
      snapshots: [
        {
          ...snapshot,
          windows: snapshot.windows.map((window) => ({
            ...window,
            usedPercent: 100,
            resetsAt: snapshot.capturedAt,
          })),
        },
      ],
      forecasts: [
        {
          ...forecasts[5],
          resetsAt: snapshot.capturedAt,
        },
      ],
    }),
    false,
  );
  const report = { snapshots: [snapshot], forecasts: [forecasts[0]] };
  assert.equal(isQuotaReport({ ...report, unexpected: true }), false);
  assert.equal(
    isQuotaReport({
      ...report,
      forecasts: [forecasts[0], forecasts[0]],
    }),
    false,
  );
  assert.equal(
    isQuotaReport({ snapshots: [], forecasts: [forecasts[0]] }),
    false,
  );
  assert.equal(
    isQuotaReport({
      ...report,
      forecasts: [{ ...forecasts[0], confidence: "medium" }],
    }),
    false,
  );
  assert.equal(
    isQuotaReport({
      ...report,
      forecasts: [
        {
          ...forecasts[3],
          projectedRunoutAt: 1_800_010_000,
        },
      ],
    }),
    false,
  );
  assert.equal(
    isQuotaReport({
      ...report,
      forecasts: [
        {
          ...forecasts[4],
          projectedRunoutAt: 1_800_010_000,
        },
      ],
    }),
    false,
  );
  assert.equal(
    isQuotaReport({
      ...report,
      forecasts: [
        {
          ...forecasts[0],
          evidence: { ...evidence, sampleCount: 65 },
        },
      ],
    }),
    false,
  );
  for (const invalid of [
    {
      ...forecasts[0],
      calculatedAt: 1_800_000_000,
    },
    {
      ...forecasts[1],
      retainedEstimate: {
        state: "insufficient",
        evidence,
      },
    },
    {
      ...forecasts[3],
      evidenceEndAt: 1_800_000_001,
    },
    {
      ...forecasts[3],
      evidenceStartAt: 1_799_996_401,
    },
    {
      ...forecasts[3],
      confidence: "high",
      evidence: {
        sampleCount: 6,
        distinctCaptureCount: 6,
        spanSeconds: 1_800,
        increasePercent: 5,
      },
    },
    {
      ...forecasts[5],
      confidence: "medium",
    },
    {
      ...forecasts[6],
      evidence,
    },
  ]) {
    assert.equal(
      isQuotaReport({ snapshots: [snapshot], forecasts: [invalid] }),
      false,
    );
  }
});
