import assert from "node:assert/strict";
import test from "node:test";
import {
  QUOTA_WINDOW_MINUTES,
  type ProviderConnectionState,
  type QuotaForecast,
  type QuotaSnapshot,
  type QuotaWindowMinutes,
} from "../shared/contracts";
import { deriveQuotaForecast, QUOTA_FORECAST_MAX_SAMPLES } from "./quota-forecast";
import type {
  QuotaHistorySample,
  QuotaHistorySegment,
} from "./quota-history";

const NOW = 1_800_000_000;

function fixture(options: {
  windowMinutes?: QuotaWindowMinutes;
  spanSeconds?: number;
  values?: number[];
  usedPercent?: number;
  resetsAt?: number;
  providerId?: "codex" | "claude";
  connectionState?: ProviderConnectionState;
  capturedAt?: number;
} = {}): {
  snapshot: QuotaSnapshot;
  segment: QuotaHistorySegment;
} {
  const windowMinutes =
    options.windowMinutes ?? QUOTA_WINDOW_MINUTES.fiveHours;
  const values = options.values ?? [0, 1, 2, 3, 4, 5];
  const spanSeconds = options.spanSeconds ?? 30 * 60;
  const resetsAt =
    options.resetsAt ??
    NOW + (windowMinutes === QUOTA_WINDOW_MINUTES.fiveHours ? 7_200 : 604_800);
  const providerId = options.providerId ?? "codex";
  const samples = values.map((usedPercent, index) => {
    const capturedAt =
      NOW -
      spanSeconds +
      Math.round((spanSeconds * index) / Math.max(1, values.length - 1));
    return { capturedAt, observedAt: capturedAt, usedPercent };
  });
  const snapshot: QuotaSnapshot = {
    providerId,
    connectionState: options.connectionState ?? "connected",
    capturedAt: options.capturedAt ?? samples.at(-1)?.capturedAt ?? NOW,
    windows:
      (options.connectionState ?? "connected") === "connected"
        ? [
            {
              label: "Quota",
              usedPercent: options.usedPercent ?? values.at(-1) ?? 0,
              windowMinutes,
              resetsAt,
            },
          ]
        : [],
  };
  return {
    snapshot,
    segment: { providerId, windowMinutes, resetsAt, samples },
  };
}

test("accepts exact medium and high gates for both window durations", () => {
  for (const [windowMinutes, mediumSpan, highSpan] of [
    [QUOTA_WINDOW_MINUTES.fiveHours, 30 * 60, 60 * 60],
    [QUOTA_WINDOW_MINUTES.weekly, 12 * 60 * 60, 24 * 60 * 60],
  ] as const) {
    const medium = fixture({
      windowMinutes,
      spanSeconds: mediumSpan,
      values: [90, 91, 92, 93, 94, 95],
      usedPercent: 95,
    });
    assert.deepEqual(
      deriveQuotaForecast(
        medium.snapshot,
        windowMinutes,
        medium.segment,
        NOW,
      ),
      {
        providerId: "codex",
        windowMinutes,
        resetsAt: medium.segment.resetsAt,
        state: "projected-runout",
        confidence: "medium",
        calculatedAt: NOW,
        evidenceStartAt: NOW - mediumSpan,
        evidenceEndAt: NOW,
        projectedRunoutAt: NOW + mediumSpan,
        evidence: {
          sampleCount: 6,
          distinctCaptureCount: 6,
          spanSeconds: mediumSpan,
          increasePercent: 5,
        },
      },
    );

    const high = fixture({
      windowMinutes,
      spanSeconds: highSpan,
      values: [80, 81, 82, 83, 84, 86, 87, 88, 89, 90],
      usedPercent: 95,
    });
    const result = deriveQuotaForecast(
      high.snapshot,
      windowMinutes,
      high.segment,
      NOW,
    );
    assert.equal(result.state, "projected-runout");
    if (result.state !== "projected-runout") {
      assert.fail("Expected a projected runout");
    }
    assert.equal(result.confidence, "high");
    assert.equal(result.calculatedAt, NOW);
    assert.equal(result.evidenceStartAt, NOW - highSpan);
    assert.equal(result.evidenceEndAt, NOW);
    assert.equal(result.evidence.distinctCaptureCount, 10);
    assert.equal(result.evidence.increasePercent, 10);
    assert.equal(result.evidence.spanSeconds, highSpan);
  }
});

test("rejects every just-below-medium evidence boundary", () => {
  for (const candidate of [
    fixture({ values: [90, 91, 92, 93, 95], usedPercent: 95 }),
    fixture({ values: [90, 91, 92, 93, 94, 94.99], usedPercent: 95 }),
    fixture({ spanSeconds: 30 * 60 - 1, usedPercent: 95 }),
    fixture({
      windowMinutes: QUOTA_WINDOW_MINUTES.weekly,
      spanSeconds: 12 * 60 * 60 - 1,
      usedPercent: 95,
    }),
  ]) {
    assert.equal(
      deriveQuotaForecast(
        candidate.snapshot,
        candidate.segment.windowMinutes,
        candidate.segment,
        NOW,
      ).state,
      "insufficient",
    );
  }
});

test("classifies every just-below-high boundary as medium", () => {
  for (const candidate of [
    fixture({
      spanSeconds: 60 * 60,
      values: [80, 82, 84, 86, 88, 90, 91, 92, 93],
      usedPercent: 95,
    }),
    fixture({
      spanSeconds: 60 * 60,
      values: [80, 81, 82, 83, 84, 85, 86, 87, 88, 89.99],
      usedPercent: 95,
    }),
    fixture({
      spanSeconds: 60 * 60 - 1,
      values: [80, 81, 82, 83, 84, 86, 87, 88, 89, 90],
      usedPercent: 95,
    }),
    fixture({
      windowMinutes: QUOTA_WINDOW_MINUTES.weekly,
      spanSeconds: 24 * 60 * 60 - 1,
      values: [80, 81, 82, 83, 84, 86, 87, 88, 89, 90],
      usedPercent: 95,
    }),
  ]) {
    const result = deriveQuotaForecast(
      candidate.snapshot,
      candidate.segment.windowMinutes,
      candidate.segment,
      NOW,
    );
    assert.notEqual(result.state, "insufficient");
    if (
      result.state !== "safe-through-reset" &&
      result.state !== "projected-runout"
    ) {
      assert.fail("Expected a calculated forecast");
    }
    assert.equal(result.confidence, "medium");
  }
});

test("uses captured times, collapses polling duplicates, and caps evidence at 64 samples", () => {
  const duplicate = fixture();
  duplicate.segment.samples = duplicate.segment.samples.flatMap((sample) => [
    sample,
    { ...sample, observedAt: Math.min(NOW, sample.observedAt + 60) },
  ]);
  const duplicateResult = deriveQuotaForecast(
    duplicate.snapshot,
    duplicate.segment.windowMinutes,
    duplicate.segment,
    NOW,
  );
  assert.equal(duplicateResult.evidence.sampleCount, 12);
  assert.equal(duplicateResult.evidence.distinctCaptureCount, 6);
  assert.equal(duplicateResult.evidence.spanSeconds, 30 * 60);

  const capped = fixture({
    spanSeconds: 70 * 60,
    values: Array.from({ length: 70 }, (_, index) => index),
    usedPercent: 95,
  });
  const cappedResult = deriveQuotaForecast(
    capped.snapshot,
    capped.segment.windowMinutes,
    capped.segment,
    NOW,
  );
  assert.equal(cappedResult.evidence.sampleCount, QUOTA_FORECAST_MAX_SAMPLES);
  assert.equal(
    cappedResult.evidence.distinctCaptureCount,
    QUOTA_FORECAST_MAX_SAMPLES,
  );
});

test("flat, decreasing, outlier, conflicting duplicate, and sparse histories remain insufficient", () => {
  const candidates = [
    fixture({ values: [10, 10, 10, 10, 10, 10] }),
    fixture({ values: [10, 11, 12, 11, 14, 15] }),
    fixture({ values: [10, 11, 90, 13, 14, 15] }),
    fixture({ values: [10, 11] }),
  ];
  const conflicting = fixture();
  conflicting.segment.samples.splice(1, 0, {
    ...conflicting.segment.samples[0]!,
    usedPercent: 2,
  });
  candidates.push(conflicting);
  for (const candidate of candidates) {
    const result = deriveQuotaForecast(
      candidate.snapshot,
      candidate.segment.windowMinutes,
      candidate.segment,
      NOW,
    );
    assert.equal(result.state, "insufficient");
    assert.equal("projectedRunoutAt" in result, false);
  }
});

test("median slope is robust to a delayed flat sample", () => {
  const candidate = fixture({
    spanSeconds: 60 * 60,
    values: [80, 81, 82, 83, 84, 84, 86, 87, 88, 90],
    usedPercent: 95,
  });
  const result = deriveQuotaForecast(
    candidate.snapshot,
    candidate.segment.windowMinutes,
    candidate.segment,
    NOW,
  );
  assert.equal(result.state, "projected-runout");
  if (result.state !== "projected-runout") {
    assert.fail("Expected a projected runout");
  }
  assert.equal(result.confidence, "high");
  assert.ok(
    result.projectedRunoutAt !== undefined &&
      result.projectedRunoutAt > NOW &&
      result.projectedRunoutAt < candidate.segment.resetsAt,
  );
});

test("distinguishes safe-through-reset from a finite projected runout", () => {
  const runout = fixture({
    values: [90, 91, 92, 93, 94, 95],
    usedPercent: 95,
  });
  assert.equal(
    deriveQuotaForecast(
      runout.snapshot,
      runout.segment.windowMinutes,
      runout.segment,
      NOW,
    ).state,
    "projected-runout",
  );

  const safe = fixture({
    values: [0, 1, 2, 3, 4, 5],
    usedPercent: 5,
    resetsAt: NOW + 3_600,
  });
  const safeResult = deriveQuotaForecast(
    safe.snapshot,
    safe.segment.windowMinutes,
    safe.segment,
    NOW,
  );
  assert.equal(safeResult.state, "safe-through-reset");
  if (safeResult.state !== "safe-through-reset") {
    assert.fail("Expected safe through reset");
  }
  assert.equal(safeResult.confidence, "medium");
  assert.equal("projectedRunoutAt" in safeResult, false);
});

test("pauses stale Claude data and rejects reset, expiry, and connection mismatches", () => {
  const stale = fixture({
    providerId: "claude",
    capturedAt: NOW - 301,
  });
  assert.equal(
    deriveQuotaForecast(
      stale.snapshot,
      stale.segment.windowMinutes,
      stale.segment,
      NOW,
    ).state,
    "stale-paused",
  );

  const resetMismatch = fixture();
  resetMismatch.segment.resetsAt += 1;
  assert.equal(
    deriveQuotaForecast(
      resetMismatch.snapshot,
      resetMismatch.segment.windowMinutes,
      resetMismatch.segment,
      NOW,
    ).state,
    "unavailable-error",
  );

  const expired = fixture({ resetsAt: NOW });
  assert.equal(
    deriveQuotaForecast(
      expired.snapshot,
      expired.segment.windowMinutes,
      expired.segment,
      NOW,
    ).state,
    "unavailable-error",
  );

  const error = fixture({ connectionState: "error" });
  assert.equal(
    deriveQuotaForecast(
      error.snapshot,
      error.segment.windowMinutes,
      error.segment,
      NOW,
    ).state,
    "unavailable-error",
  );
});

test("retains only a same-reset calculated estimate while stale without mutating provenance", () => {
  const fresh = fixture({
    providerId: "claude",
    values: [90, 91, 92, 93, 94, 95],
    usedPercent: 95,
  });
  const calculated = deriveQuotaForecast(
    fresh.snapshot,
    fresh.segment.windowMinutes,
    fresh.segment,
    NOW,
  );
  assert.equal(calculated.state, "projected-runout");
  const before = structuredClone(calculated);
  const staleSnapshot = {
    ...fresh.snapshot,
    capturedAt: NOW - 301,
  };
  const paused = deriveQuotaForecast(
    staleSnapshot,
    fresh.segment.windowMinutes,
    fresh.segment,
    NOW,
    calculated,
  );
  assert.equal(paused.state, "stale-paused");
  if (paused.state !== "stale-paused") {
    assert.fail("Expected a paused forecast");
  }
  assert.deepEqual(paused.retainedEstimate, {
    state: "projected-runout",
    confidence: "medium",
    calculatedAt: NOW,
    evidenceStartAt: NOW - 1_800,
    evidenceEndAt: NOW,
    projectedRunoutAt: NOW + 1_800,
    evidence: calculated.evidence,
  });
  assert.deepEqual(calculated, before);
  const retained = structuredClone(paused.retainedEstimate);
  let repeated: QuotaForecast = paused;
  for (let refresh = 1; refresh <= 25; refresh += 1) {
    repeated = deriveQuotaForecast(
      staleSnapshot,
      fresh.segment.windowMinutes,
      fresh.segment,
      NOW + refresh * 60,
      repeated,
    );
    assert.equal(repeated.state, "stale-paused");
    assert.deepEqual(
      repeated.state === "stale-paused"
        ? repeated.retainedEstimate
        : undefined,
      retained,
    );
  }

  const differentReset = {
    ...calculated,
    resetsAt: calculated.resetsAt + 1,
  };
  const withoutRetention = deriveQuotaForecast(
    staleSnapshot,
    fresh.segment.windowMinutes,
    fresh.segment,
    NOW,
    differentReset,
  );
  assert.equal(withoutRetention.state, "stale-paused");
  assert.equal("retainedEstimate" in withoutRetention, false);
  const repeatedWithoutRetention = deriveQuotaForecast(
    staleSnapshot,
    fresh.segment.windowMinutes,
    fresh.segment,
    NOW + 60,
    withoutRetention,
  );
  assert.equal(repeatedWithoutRetention.state, "stale-paused");
  assert.equal("retainedEstimate" in repeatedWithoutRetention, false);

  const exhaustedSnapshot = {
    ...fresh.snapshot,
    windows: fresh.snapshot.windows.map((window) => ({
      ...window,
      usedPercent: 100,
    })),
  };
  const exhausted = deriveQuotaForecast(
    exhaustedSnapshot,
    fresh.segment.windowMinutes,
    fresh.segment,
    NOW,
  );
  assert.equal(exhausted.state, "exhausted");
  const retainedExhausted = deriveQuotaForecast(
    { ...exhaustedSnapshot, capturedAt: NOW - 301 },
    fresh.segment.windowMinutes,
    fresh.segment,
    NOW,
    exhausted,
  );
  assert.equal(retainedExhausted.state, "stale-paused");
  assert.deepEqual(
    retainedExhausted.state === "stale-paused"
      ? retainedExhausted.retainedEstimate
      : undefined,
    {
      state: "exhausted",
      calculatedAt: NOW,
      evidence: {
        sampleCount: 0,
        distinctCaptureCount: 0,
        spanSeconds: 0,
        increasePercent: 0,
      },
    },
  );
});

test("uses the latest contiguous suffix and accepts only the exact half-window gap boundary", () => {
  for (const windowMinutes of [
    QUOTA_WINDOW_MINUTES.fiveHours,
    QUOTA_WINDOW_MINUTES.weekly,
  ] as const) {
    const maximumGap = windowMinutes * 30;
    const recentSpan =
      windowMinutes === QUOTA_WINDOW_MINUTES.fiveHours
        ? 30 * 60
        : 12 * 60 * 60;
    const exact = fixture({
      windowMinutes,
      values: [90, 91, 92, 93, 94, 95],
      usedPercent: 95,
    });
    exact.segment.samples = [
      {
        capturedAt: NOW - recentSpan - maximumGap,
        observedAt: NOW - recentSpan - maximumGap,
        usedPercent: 90,
      },
      ...[91, 92, 93, 94, 95].map((usedPercent, index) => {
        const capturedAt =
          NOW -
          recentSpan +
          Math.round((recentSpan * index) / 4);
        return { capturedAt, observedAt: capturedAt, usedPercent };
      }),
    ];
    assert.notEqual(
      deriveQuotaForecast(
        exact.snapshot,
        windowMinutes,
        exact.segment,
        NOW,
      ).state,
      "insufficient",
    );

    const overBoundary = structuredClone(exact);
    overBoundary.segment.samples[0]!.capturedAt -= 1;
    overBoundary.segment.samples[0]!.observedAt -= 1;
    const split = deriveQuotaForecast(
      overBoundary.snapshot,
      windowMinutes,
      overBoundary.segment,
      NOW,
    );
    assert.equal(split.state, "insufficient");
    assert.equal(split.evidence.distinctCaptureCount, 5);
  }

  const afterSleep = fixture({
    values: [90, 91, 92, 93, 94, 95],
    usedPercent: 95,
  });
  const old = afterSleep.segment.samples.map((sample) => ({
    ...sample,
    capturedAt: sample.capturedAt - 12_000,
    observedAt: sample.observedAt - 12_000,
  }));
  const latest = fixture({
    values: [90, 91, 92, 93, 94, 95],
    usedPercent: 95,
  }).segment.samples;
  afterSleep.segment.samples = [...old, ...latest];
  const suffixResult = deriveQuotaForecast(
    afterSleep.snapshot,
    afterSleep.segment.windowMinutes,
    afterSleep.segment,
    NOW,
  );
  assert.notEqual(suffixResult.state, "insufficient");
  assert.equal(suffixResult.evidence.distinctCaptureCount, 6);
});

test("treats 100 percent as exhausted while 99.99 still forecasts and reset due is unavailable", () => {
  const almost = fixture({
    values: [90, 92, 94, 96, 98, 99.99],
    usedPercent: 99.99,
  });
  assert.equal(
    deriveQuotaForecast(
      almost.snapshot,
      almost.segment.windowMinutes,
      almost.segment,
      NOW,
    ).state,
    "projected-runout",
  );

  const exhausted = fixture({ usedPercent: 100 });
  const result = deriveQuotaForecast(
    exhausted.snapshot,
    exhausted.segment.windowMinutes,
    exhausted.segment,
    NOW,
  );
  assert.deepEqual(result, {
    providerId: "codex",
    windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
    resetsAt: exhausted.segment.resetsAt,
    state: "exhausted",
    calculatedAt: NOW,
    evidence: {
      sampleCount: 0,
      distinctCaptureCount: 0,
      spanSeconds: 0,
      increasePercent: 0,
    },
  });
  assert.equal(JSON.stringify(result).includes("NaN"), false);
  assert.equal(JSON.stringify(result).includes("Infinity"), false);

  const resetDue = fixture({ usedPercent: 100, resetsAt: NOW });
  assert.equal(
    deriveQuotaForecast(
      resetDue.snapshot,
      resetDue.segment.windowMinutes,
      resetDue.segment,
      NOW,
    ).state,
    "unavailable-error",
  );
});

test("missing and numerically unsafe evidence never produces NaN, infinity, or negative time", () => {
  const missing = fixture();
  assert.equal(
    deriveQuotaForecast(
      missing.snapshot,
      missing.segment.windowMinutes,
      undefined,
      NOW,
    ).state,
    "insufficient",
  );

  const future = fixture({ capturedAt: NOW + 1 });
  assert.equal(
    deriveQuotaForecast(
      future.snapshot,
      future.segment.windowMinutes,
      future.segment,
      NOW,
    ).state,
    "unavailable-error",
  );
});
