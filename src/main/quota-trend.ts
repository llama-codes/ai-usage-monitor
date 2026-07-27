import type {
  QuotaSnapshot,
  QuotaTrend,
  QuotaTrendPoint,
  QuotaWindow,
} from "../shared/contracts";
import type { QuotaHistorySegment } from "./quota-history";

export const QUOTA_TREND_MAX_POINTS = 32;

export function deriveQuotaTrend(
  snapshot: QuotaSnapshot,
  window: QuotaWindow,
  segment: QuotaHistorySegment | undefined,
  generatedAt: number,
): QuotaTrend | undefined {
  if (
    !Number.isSafeInteger(generatedAt) ||
    generatedAt < 0 ||
    snapshot.connectionState !== "connected" ||
    !segment ||
    segment.providerId !== snapshot.providerId ||
    segment.windowMinutes !== window.windowMinutes ||
    segment.resetsAt !== window.resetsAt
  ) {
    return undefined;
  }

  let previousCapturedAt = -1;
  let previousObservedAt = -1;
  const collapsed: QuotaHistorySegment["samples"] = [];
  for (const sample of segment.samples) {
    if (
      !Number.isSafeInteger(sample.capturedAt) ||
      sample.capturedAt < 0 ||
      sample.capturedAt < previousCapturedAt ||
      !Number.isSafeInteger(sample.observedAt) ||
      sample.observedAt < 0 ||
      sample.capturedAt > sample.observedAt ||
      sample.observedAt > generatedAt ||
      sample.observedAt >= segment.resetsAt ||
      sample.observedAt < previousObservedAt ||
      sample.capturedAt > snapshot.capturedAt ||
      sample.capturedAt >= window.resetsAt ||
      typeof sample.usedPercent !== "number" ||
      !Number.isFinite(sample.usedPercent) ||
      sample.usedPercent < 0 ||
      sample.usedPercent > 100
    ) {
      return undefined;
    }
    // Exact observedAt equality is valid in the persisted history contract.
    // The later input sample wins an otherwise exact duplicate tie.
    previousObservedAt = sample.observedAt;
    if (sample.capturedAt === previousCapturedAt) {
      const prior = collapsed.at(-1);
      if (!prior) {
        return undefined;
      }
      if (sample.observedAt >= prior.observedAt) {
        collapsed[collapsed.length - 1] = { ...sample };
      }
      continue;
    }
    previousCapturedAt = sample.capturedAt;
    collapsed.push({ ...sample });
  }

  const points = collapsed.map((sample) => ({
      capturedAt: sample.capturedAt,
      usedPercent: sample.usedPercent,
    }));

  if (points.length === 0) {
    return undefined;
  }
  const latest = points.at(-1);
  if (
    !latest ||
    latest.capturedAt !== snapshot.capturedAt ||
    latest.usedPercent !== window.usedPercent
  ) {
    return undefined;
  }

  return {
    providerId: snapshot.providerId,
    windowMinutes: window.windowMinutes,
    resetsAt: window.resetsAt,
    points: downsampleQuotaTrend(points),
  };
}

export function downsampleQuotaTrend(
  points: readonly QuotaTrendPoint[],
  maximum = QUOTA_TREND_MAX_POINTS,
): QuotaTrendPoint[] {
  if (!Number.isSafeInteger(maximum) || maximum < 2) {
    throw new TypeError("Trend point limit must be at least two");
  }
  if (points.length <= maximum) {
    return points.map(clonePoint);
  }

  const selected = new Set<number>([0, points.length - 1]);
  const bucketCount = Math.floor((maximum - 2) / 2);
  const interiorCount = points.length - 2;

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start =
      1 + Math.floor((bucket * interiorCount) / bucketCount);
    const end =
      1 + Math.floor(((bucket + 1) * interiorCount) / bucketCount);
    let minimumIndex = start;
    let maximumIndex = start;
    for (let index = start + 1; index < end; index += 1) {
      const point = points[index];
      const minimum = points[minimumIndex];
      const maximumPoint = points[maximumIndex];
      if (!point || !minimum || !maximumPoint) {
        continue;
      }
      if (point.usedPercent < minimum.usedPercent) {
        minimumIndex = index;
      }
      if (point.usedPercent >= maximumPoint.usedPercent) {
        maximumIndex = index;
      }
    }
    selected.add(minimumIndex);
    selected.add(maximumIndex);
  }

  return [...selected]
    .sort((left, right) => left - right)
    .slice(0, maximum)
    .flatMap((index) => {
      const point = points[index];
      return point ? [clonePoint(point)] : [];
    });
}

function clonePoint(point: QuotaTrendPoint): QuotaTrendPoint {
  return {
    capturedAt: point.capturedAt,
    usedPercent: point.usedPercent,
  };
}
