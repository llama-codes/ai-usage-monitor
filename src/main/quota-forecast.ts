import {
  QUOTA_WINDOW_MINUTES,
  type QuotaCalculatedForecastEstimate,
  type QuotaForecast,
  type QuotaForecastConfidence,
  type QuotaForecastEvidence,
  type QuotaSnapshot,
  type QuotaWindowMinutes,
} from "../shared/contracts";
import { CLAUDE_STALE_AFTER_SECONDS } from "./monitor-state";
import type {
  QuotaHistorySample,
  QuotaHistorySegment,
} from "./quota-history";

export const QUOTA_FORECAST_MAX_SAMPLES = 64;

const MEDIUM_GATES = {
  distinctCaptureCount: 6,
  increasePercent: 5,
  spans: {
    [QUOTA_WINDOW_MINUTES.fiveHours]: 30 * 60,
    [QUOTA_WINDOW_MINUTES.weekly]: 12 * 60 * 60,
  },
} as const;

const HIGH_GATES = {
  distinctCaptureCount: 10,
  increasePercent: 10,
  spans: {
    [QUOTA_WINDOW_MINUTES.fiveHours]: 60 * 60,
    [QUOTA_WINDOW_MINUTES.weekly]: 24 * 60 * 60,
  },
} as const;

export function deriveQuotaForecast(
  snapshot: QuotaSnapshot,
  windowMinutes: QuotaWindowMinutes,
  currentSegment: QuotaHistorySegment | undefined,
  nowSeconds: number,
  priorForecast?: QuotaForecast,
): QuotaForecast {
  const currentWindow = snapshot.windows.find(
    (window) => window.windowMinutes === windowMinutes,
  );
  const resetsAt = currentWindow?.resetsAt ?? currentSegment?.resetsAt ?? 0;
  const emptyEvidence = evidence([]);
  const base = {
    providerId: snapshot.providerId,
    windowMinutes,
    resetsAt,
  };

  if (
    !isUnixSeconds(nowSeconds) ||
    !isUnixSeconds(snapshot.capturedAt) ||
    snapshot.capturedAt > nowSeconds ||
    snapshot.connectionState !== "connected" ||
    !currentWindow ||
    !isPercentage(currentWindow.usedPercent) ||
    currentWindow.resetsAt <= nowSeconds
  ) {
    return { ...base, state: "unavailable-error", evidence: emptyEvidence };
  }
  if (
    snapshot.providerId === "claude" &&
    nowSeconds - snapshot.capturedAt > CLAUDE_STALE_AFTER_SECONDS
  ) {
    const retainedEstimate = retainMatchingEstimate(priorForecast, base);
    return retainedEstimate
      ? {
          ...base,
          state: "stale-paused",
          evidence: emptyEvidence,
          retainedEstimate,
        }
      : { ...base, state: "stale-paused", evidence: emptyEvidence };
  }
  if (currentWindow.usedPercent >= 100) {
    return {
      ...base,
      state: "exhausted",
      calculatedAt: nowSeconds,
      evidence: emptyEvidence,
    };
  }
  if (!currentSegment) {
    return { ...base, state: "insufficient", evidence: emptyEvidence };
  }
  if (
    currentSegment.providerId !== snapshot.providerId ||
    currentSegment.windowMinutes !== windowMinutes ||
    currentSegment.resetsAt !== currentWindow.resetsAt
  ) {
    return { ...base, state: "unavailable-error", evidence: emptyEvidence };
  }

  const selected = selectChronologicalSamples(
    currentSegment.samples,
    windowMinutes,
    currentWindow.resetsAt,
    nowSeconds,
  );
  const forecastEvidence = evidence(
    selected.samples,
    selected.sampleCount,
  );
  const confidence = classifyConfidence(
    forecastEvidence,
    windowMinutes,
    selected.monotonic,
  );
  if (!confidence) {
    return {
      ...base,
      state: "insufficient",
      evidence: forecastEvidence,
    };
  }

  const slopes = positivePairwiseSlopes(selected.samples);
  const slope = median(slopes);
  if (!Number.isFinite(slope) || slope <= 0) {
    return {
      ...base,
      state: "insufficient",
      evidence: forecastEvidence,
    };
  }

  const latestCapture =
    selected.samples.at(-1)?.capturedAt ?? snapshot.capturedAt;
  const earliestCapture =
    selected.samples[0]?.capturedAt ?? snapshot.capturedAt;
  const baselineAt = Math.max(nowSeconds, snapshot.capturedAt, latestCapture);
  const provenance = {
    calculatedAt: nowSeconds,
    evidenceStartAt: earliestCapture,
    evidenceEndAt: latestCapture,
  };
  const remainingPercent = 100 - currentWindow.usedPercent;
  const projectedRunoutAt =
    baselineAt + Math.ceil(remainingPercent / slope);
  if (
    !Number.isSafeInteger(projectedRunoutAt) ||
    projectedRunoutAt <= baselineAt ||
    projectedRunoutAt >= currentWindow.resetsAt
  ) {
    return {
      ...base,
      state: "safe-through-reset",
      confidence,
      ...provenance,
      evidence: forecastEvidence,
    };
  }
  return {
    ...base,
    state: "projected-runout",
    confidence,
    ...provenance,
    projectedRunoutAt,
    evidence: forecastEvidence,
  };
}

function selectChronologicalSamples(
  samples: readonly QuotaHistorySample[],
  windowMinutes: QuotaWindowMinutes,
  resetsAt: number,
  nowSeconds: number,
): {
  samples: QuotaHistorySample[];
  sampleCount: number;
  monotonic: boolean;
} {
  const selected = samples.slice(-QUOTA_FORECAST_MAX_SAMPLES);
  const distinct: Array<{
    sample: QuotaHistorySample;
    rawCount: number;
    conflict: boolean;
  }> = [];
  let structurallyValid = true;
  for (const sample of selected) {
    if (
      !isUnixSeconds(sample.capturedAt) ||
      !isUnixSeconds(sample.observedAt) ||
      !isPercentage(sample.usedPercent) ||
      sample.capturedAt > sample.observedAt ||
      sample.observedAt > nowSeconds ||
      sample.capturedAt >= resetsAt ||
      sample.observedAt >= resetsAt
    ) {
      structurallyValid = false;
      continue;
    }
    const previous = distinct.at(-1);
    if (previous && sample.capturedAt < previous.sample.capturedAt) {
      structurallyValid = false;
      continue;
    }
    if (previous && sample.capturedAt === previous.sample.capturedAt) {
      previous.rawCount += 1;
      if (sample.usedPercent !== previous.sample.usedPercent) {
        previous.conflict = true;
      }
      continue;
    }
    distinct.push({
      sample: { ...sample },
      rawCount: 1,
      conflict: false,
    });
  }

  const maximumGapSeconds = windowMinutes * 30;
  let suffixStart = 0;
  for (let index = 1; index < distinct.length; index += 1) {
    const previous = distinct[index - 1];
    const current = distinct[index];
    if (
      previous &&
      current &&
      current.sample.capturedAt - previous.sample.capturedAt >
        maximumGapSeconds
    ) {
      suffixStart = index;
    }
  }
  const suffix = distinct.slice(suffixStart);
  let monotonic =
    structurallyValid && suffix.every((entry) => !entry.conflict);
  for (let index = 1; index < suffix.length; index += 1) {
    const previous = suffix[index - 1];
    const current = suffix[index];
    if (
      previous &&
      current &&
      current.sample.usedPercent < previous.sample.usedPercent
    ) {
      monotonic = false;
    }
  }
  return {
    samples: suffix.map((entry) => entry.sample),
    sampleCount: suffix.reduce((total, entry) => total + entry.rawCount, 0),
    monotonic,
  };
}

function retainMatchingEstimate(
  priorForecast: QuotaForecast | undefined,
  base: Pick<QuotaForecast, "providerId" | "windowMinutes" | "resetsAt">,
): QuotaCalculatedForecastEstimate | undefined {
  if (
    !priorForecast ||
    priorForecast.providerId !== base.providerId ||
    priorForecast.windowMinutes !== base.windowMinutes ||
    priorForecast.resetsAt !== base.resetsAt
  ) {
    return undefined;
  }
  if (priorForecast.state === "stale-paused") {
    return priorForecast.retainedEstimate
      ? cloneCalculatedEstimate(priorForecast.retainedEstimate)
      : undefined;
  }
  if (
    priorForecast.state === "exhausted" ||
    priorForecast.state === "safe-through-reset" ||
    priorForecast.state === "projected-runout"
  ) {
    return cloneCalculatedEstimate(priorForecast);
  }
  return undefined;
}

function cloneCalculatedEstimate(
  estimate: QuotaCalculatedForecastEstimate,
): QuotaCalculatedForecastEstimate {
  if (estimate.state === "exhausted") {
    return {
      state: "exhausted",
      calculatedAt: estimate.calculatedAt,
      evidence: { ...estimate.evidence },
    };
  }
  if (estimate.state === "safe-through-reset") {
    return {
      state: "safe-through-reset",
      confidence: estimate.confidence,
      calculatedAt: estimate.calculatedAt,
      evidenceStartAt: estimate.evidenceStartAt,
      evidenceEndAt: estimate.evidenceEndAt,
      evidence: { ...estimate.evidence },
    };
  }
  return {
    state: "projected-runout",
    confidence: estimate.confidence,
    calculatedAt: estimate.calculatedAt,
    evidenceStartAt: estimate.evidenceStartAt,
    evidenceEndAt: estimate.evidenceEndAt,
    projectedRunoutAt: estimate.projectedRunoutAt,
    evidence: { ...estimate.evidence },
  };
}

function evidence(
  samples: readonly QuotaHistorySample[],
  sampleCount = samples.length,
): QuotaForecastEvidence {
  const first = samples[0];
  const last = samples.at(-1);
  return {
    sampleCount,
    distinctCaptureCount: samples.length,
    spanSeconds:
      first && last ? Math.max(0, last.capturedAt - first.capturedAt) : 0,
    increasePercent:
      first && last
        ? Math.max(0, last.usedPercent - first.usedPercent)
        : 0,
  };
}

function classifyConfidence(
  value: QuotaForecastEvidence,
  windowMinutes: QuotaWindowMinutes,
  monotonic: boolean,
): QuotaForecastConfidence | undefined {
  if (!monotonic) {
    return undefined;
  }
  if (
    value.distinctCaptureCount >= HIGH_GATES.distinctCaptureCount &&
    value.increasePercent >= HIGH_GATES.increasePercent &&
    value.spanSeconds >= HIGH_GATES.spans[windowMinutes]
  ) {
    return "high";
  }
  if (
    value.distinctCaptureCount >= MEDIUM_GATES.distinctCaptureCount &&
    value.increasePercent >= MEDIUM_GATES.increasePercent &&
    value.spanSeconds >= MEDIUM_GATES.spans[windowMinutes]
  ) {
    return "medium";
  }
  return undefined;
}

function positivePairwiseSlopes(
  samples: readonly QuotaHistorySample[],
): number[] {
  const slopes: number[] = [];
  for (let left = 0; left < samples.length; left += 1) {
    for (let right = left + 1; right < samples.length; right += 1) {
      const earlier = samples[left];
      const later = samples[right];
      if (!earlier || !later) {
        continue;
      }
      const elapsed = later.capturedAt - earlier.capturedAt;
      const increase = later.usedPercent - earlier.usedPercent;
      if (elapsed > 0 && increase > 0) {
        slopes.push(increase / elapsed);
      }
    }
  }
  return slopes;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? Number.NaN)
    : ((sorted[middle - 1] ?? Number.NaN) +
        (sorted[middle] ?? Number.NaN)) /
        2;
}

function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPercentage(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}
