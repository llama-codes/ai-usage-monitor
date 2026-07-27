import assert from "node:assert/strict";
import test from "node:test";
import {
  QUOTA_WINDOW_MINUTES,
  type QuotaSnapshot,
  type QuotaTrendPoint,
} from "../shared/contracts";
import type { QuotaHistorySegment } from "./quota-history";
import {
  deriveQuotaTrend,
  downsampleQuotaTrend,
  QUOTA_TREND_MAX_POINTS,
} from "./quota-trend";

const CAPTURED_AT = 1_800_000_000;
const RESETS_AT = CAPTURED_AT + 10_000;
const snapshot: QuotaSnapshot = {
  providerId: "codex",
  connectionState: "connected",
  capturedAt: CAPTURED_AT,
  windows: [
    {
      label: "Five hours",
      usedPercent: 42,
      windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
      resetsAt: RESETS_AT,
    },
  ],
};

function segment(points: QuotaTrendPoint[]): QuotaHistorySegment {
  return {
    providerId: "codex",
    windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
    resetsAt: RESETS_AT,
    samples: points.map((point) => ({
      ...point,
      observedAt: point.capturedAt,
    })),
  };
}

test("derives only real chronological samples from the authoritative current reset", () => {
  const points = [
    { capturedAt: CAPTURED_AT - 120, usedPercent: 20 },
    { capturedAt: CAPTURED_AT - 60, usedPercent: 30 },
    { capturedAt: CAPTURED_AT, usedPercent: 42 },
  ];
  assert.deepEqual(
    deriveQuotaTrend(
      snapshot,
      snapshot.windows[0]!,
      segment(points),
      CAPTURED_AT,
    ),
    {
      providerId: "codex",
      windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
      resetsAt: RESETS_AT,
      points,
    },
  );
  assert.equal(
    deriveQuotaTrend(snapshot, snapshot.windows[0]!, {
      ...segment(points),
      resetsAt: RESETS_AT + 1,
    }, CAPTURED_AT),
    undefined,
  );
  assert.equal(
    deriveQuotaTrend(snapshot, snapshot.windows[0]!, {
      ...segment(points),
      providerId: "claude",
    }, CAPTURED_AT),
    undefined,
  );
});

test("collapses equal captures to the latest observation and then the last real sample", () => {
  const duplicateSegment = segment([
    { capturedAt: CAPTURED_AT - 60, usedPercent: 10 },
    { capturedAt: CAPTURED_AT, usedPercent: 35 },
  ]);
  duplicateSegment.samples = [
    {
      capturedAt: CAPTURED_AT - 60,
      observedAt: CAPTURED_AT - 20,
      usedPercent: 10,
    },
    {
      capturedAt: CAPTURED_AT - 60,
      observedAt: CAPTURED_AT - 10,
      usedPercent: 20,
    },
    {
      capturedAt: CAPTURED_AT,
      observedAt: CAPTURED_AT,
      usedPercent: 35,
    },
    {
      capturedAt: CAPTURED_AT,
      observedAt: CAPTURED_AT + 1,
      usedPercent: 41,
    },
    {
      capturedAt: CAPTURED_AT,
      observedAt: CAPTURED_AT + 1,
      usedPercent: 42,
    },
    {
      capturedAt: CAPTURED_AT,
      observedAt: CAPTURED_AT + 2,
      usedPercent: 42,
    },
  ];
  const result = deriveQuotaTrend(
    snapshot,
    snapshot.windows[0]!,
    duplicateSegment,
    CAPTURED_AT + 2,
  );
  assert.deepEqual(result?.points, [
    { capturedAt: CAPTURED_AT - 60, usedPercent: 20 },
    { capturedAt: CAPTURED_AT, usedPercent: 42 },
  ]);
  assert.ok(
    result?.points.every((point) =>
      duplicateSegment.samples.some(
        (sample) =>
          sample.capturedAt === point.capturedAt &&
          sample.usedPercent === point.usedPercent,
      ),
    ),
  );
  assert.equal(
    result?.points.some((point) => point.usedPercent === 41),
    false,
  );
});

test("validates observation time before choosing duplicate winners", () => {
  const base = segment([
    { capturedAt: CAPTURED_AT - 60, usedPercent: 20 },
    { capturedAt: CAPTURED_AT, usedPercent: 42 },
  ]);
  const invalidSamples = [
    [
      {
        ...base.samples[0]!,
        observedAt: base.samples[0]!.capturedAt - 1,
      },
      base.samples[1]!,
    ],
    [
      base.samples[0]!,
      {
        ...base.samples[1]!,
        observedAt: CAPTURED_AT + 1,
      },
    ],
    [
      base.samples[0]!,
      {
        ...base.samples[1]!,
        observedAt: RESETS_AT,
      },
    ],
    [
      {
        ...base.samples[0]!,
        observedAt: CAPTURED_AT - 10,
      },
      {
        ...base.samples[1]!,
        observedAt: CAPTURED_AT - 20,
      },
    ],
  ];
  for (const samples of invalidSamples) {
    assert.equal(
      deriveQuotaTrend(
        snapshot,
        snapshot.windows[0]!,
        { ...base, samples },
        CAPTURED_AT,
      ),
      undefined,
    );
  }

  const invalidDuplicate = {
    ...base,
    samples: [
      base.samples[0]!,
      base.samples[1]!,
      {
        ...base.samples[1]!,
        observedAt: CAPTURED_AT + 1,
        usedPercent: 99,
      },
    ],
  };
  assert.equal(
    deriveQuotaTrend(
      snapshot,
      snapshot.windows[0]!,
      invalidDuplicate,
      CAPTURED_AT,
    ),
    undefined,
  );
});

test("accepts Claude observations made after their source capture", () => {
  const claudeSnapshot: QuotaSnapshot = {
    ...snapshot,
    providerId: "claude",
  };
  const claudeSegment: QuotaHistorySegment = {
    ...segment([
      { capturedAt: CAPTURED_AT - 60, usedPercent: 20 },
      { capturedAt: CAPTURED_AT, usedPercent: 42 },
    ]),
    providerId: "claude",
    samples: [
      {
        capturedAt: CAPTURED_AT - 60,
        observedAt: CAPTURED_AT - 55,
        usedPercent: 20,
      },
      {
        capturedAt: CAPTURED_AT,
        observedAt: CAPTURED_AT + 5,
        usedPercent: 42,
      },
    ],
  };
  assert.deepEqual(
    deriveQuotaTrend(
      claudeSnapshot,
      claudeSnapshot.windows[0]!,
      claudeSegment,
      CAPTURED_AT + 5,
    )?.points,
    [
      { capturedAt: CAPTURED_AT - 60, usedPercent: 20 },
      { capturedAt: CAPTURED_AT, usedPercent: 42 },
    ],
  );
});

test("caps at 32 while retaining first, latest, extrema, shape, and real values", () => {
  const points = Array.from({ length: 97 }, (_, index) => ({
    capturedAt: CAPTURED_AT - 9_600 + index * 100,
    usedPercent:
      index === 17 ? 0 : index === 73 ? 100 : 40 + (index % 9),
  }));
  const result = downsampleQuotaTrend(points);
  assert.ok(result.length <= QUOTA_TREND_MAX_POINTS);
  assert.deepEqual(result[0], points[0]);
  assert.deepEqual(result.at(-1), points.at(-1));
  assert.ok(result.some((point) => point === undefined) === false);
  assert.ok(result.some((point) => point.usedPercent === 0));
  assert.ok(result.some((point) => point.usedPercent === 100));
  assert.ok(
    result.every((point) =>
      points.some(
        (source) =>
          source.capturedAt === point.capturedAt &&
          source.usedPercent === point.usedPercent,
      ),
    ),
  );
  assert.ok(
    result.every(
      (point, index) =>
        index === 0 || result[index - 1]!.capturedAt < point.capturedAt,
    ),
  );
  assert.deepEqual(downsampleQuotaTrend(points), result);
});

test("preserves flat, sparse, and outlier series without synthetic averages", () => {
  const sparse = [
    { capturedAt: 1, usedPercent: 50 },
    { capturedAt: 2, usedPercent: 50 },
  ];
  assert.deepEqual(downsampleQuotaTrend(sparse), sparse);
  const flat = Array.from({ length: 65 }, (_, index) => ({
    capturedAt: index + 1,
    usedPercent: 50,
  }));
  const flatResult = downsampleQuotaTrend(flat);
  assert.equal(flatResult[0]?.capturedAt, 1);
  assert.equal(flatResult.at(-1)?.capturedAt, 65);
  assert.ok(flatResult.every((point) => point.usedPercent === 50));
  const outlier = flat.map((point, index) =>
    index === 31 ? { ...point, usedPercent: 99 } : point,
  );
  assert.ok(
    downsampleQuotaTrend(outlier).some(
      (point) => point.capturedAt === 32 && point.usedPercent === 99,
    ),
  );
});

test("contains malformed or unavailable history by omitting the trend", () => {
  const base = segment([
    { capturedAt: CAPTURED_AT - 60, usedPercent: 20 },
    { capturedAt: CAPTURED_AT, usedPercent: 30 },
  ]);
  for (const invalid of [
    undefined,
    { ...base, samples: [] },
    {
      ...base,
      samples: [
        base.samples[1]!,
        base.samples[0]!,
      ],
    },
    {
      ...base,
      samples: [
        ...base.samples,
        {
          capturedAt: CAPTURED_AT + 1,
          observedAt: CAPTURED_AT + 1,
          usedPercent: 31,
        },
      ],
    },
    {
      ...base,
      samples: [{ ...base.samples[0]!, usedPercent: Number.NaN }],
    },
  ]) {
    assert.equal(
      deriveQuotaTrend(
        snapshot,
        snapshot.windows[0]!,
        invalid,
        CAPTURED_AT,
      ),
      undefined,
    );
  }
});
