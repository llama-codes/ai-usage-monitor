import type { QuotaSnapshot, QuotaWindowMinutes } from "../shared/contracts";

export const POLL_INTERVAL_MS = 60_000;
export const CLAUDE_STALE_AFTER_SECONDS = 5 * 60;
export const FAILURE_NOTIFICATION_THRESHOLD = 3;
export const QUOTA_NOTIFICATION_THRESHOLDS = [80, 90, 100] as const;

export type TraySeverity = "healthy" | "warning" | "critical";
export type QuotaNotificationThreshold =
  (typeof QUOTA_NOTIFICATION_THRESHOLDS)[number];

export type ThresholdNotification = {
  kind: "threshold";
  key: string;
  providerId: string;
  windowMinutes: QuotaWindowMinutes;
  resetsAt: number;
  threshold: QuotaNotificationThreshold;
  usedPercent: number;
};

export type FailureNotification = {
  kind: "refresh-failure";
  consecutiveFailures: number;
};

export type MonitorNotification =
  | ThresholdNotification
  | FailureNotification;

export type MonitorDecision = {
  traySeverity: TraySeverity;
  consecutiveFailures: number;
  notifications: MonitorNotification[];
};

export type MonitorEvaluation = {
  snapshots: QuotaSnapshot[];
  refreshFailed: boolean;
  nowSeconds: number;
};

export class QuotaMonitorPolicy {
  private consecutiveFailures = 0;
  private failureNotificationSent = false;
  private lastTrustworthySeverity: TraySeverity | undefined;
  private thresholdNotificationKeys = new Set<string>();

  evaluate(evaluation: MonitorEvaluation): MonitorDecision {
    const notifications: MonitorNotification[] = [];
    this.updateFailureState(evaluation.refreshFailed, notifications);
    this.updateThresholdState(evaluation, notifications);

    const trustworthySeverity = getWorstTrustworthySeverity(
      evaluation.snapshots,
      evaluation.nowSeconds,
    );
    if (trustworthySeverity) {
      this.lastTrustworthySeverity = trustworthySeverity;
    }

    let traySeverity =
      trustworthySeverity ?? this.lastTrustworthySeverity ?? "warning";
    if (evaluation.refreshFailed && traySeverity !== "critical") {
      traySeverity = "warning";
    }

    return {
      traySeverity,
      consecutiveFailures: this.consecutiveFailures,
      notifications,
    };
  }

  private updateFailureState(
    refreshFailed: boolean,
    notifications: MonitorNotification[],
  ): void {
    if (!refreshFailed) {
      this.consecutiveFailures = 0;
      this.failureNotificationSent = false;
      return;
    }

    this.consecutiveFailures += 1;
    if (
      this.consecutiveFailures >= FAILURE_NOTIFICATION_THRESHOLD &&
      !this.failureNotificationSent
    ) {
      this.failureNotificationSent = true;
      notifications.push({
        kind: "refresh-failure",
        consecutiveFailures: this.consecutiveFailures,
      });
    }
  }

  private updateThresholdState(
    evaluation: MonitorEvaluation,
    notifications: MonitorNotification[],
  ): void {
    this.thresholdNotificationKeys = new Set(
      [...this.thresholdNotificationKeys].filter(
        (key) => getResetTimeFromThresholdKey(key) >= evaluation.nowSeconds,
      ),
    );
    for (const snapshot of evaluation.snapshots) {
      if (
        snapshot.connectionState !== "connected" ||
        isStaleClaudeSnapshot(snapshot, evaluation.nowSeconds)
      ) {
        continue;
      }

      for (const window of snapshot.windows) {
        if (window.resetsAt <= evaluation.nowSeconds) {
          continue;
        }
        const windowKey = createWindowKey(
          snapshot.providerId,
          window.windowMinutes,
          window.resetsAt,
        );
        const reached = QUOTA_NOTIFICATION_THRESHOLDS.filter(
          (threshold) => window.usedPercent >= threshold,
        );
        for (const threshold of reached) {
          const thresholdKey = createThresholdKey(windowKey, threshold);
          if (this.thresholdNotificationKeys.has(thresholdKey)) {
            continue;
          }
          this.thresholdNotificationKeys.add(thresholdKey);
          notifications.push({
            kind: "threshold",
            key: thresholdKey,
            providerId: snapshot.providerId,
            windowMinutes: window.windowMinutes,
            resetsAt: window.resetsAt,
            threshold,
            usedPercent: window.usedPercent,
          });
        }
      }
    }
  }
}

export function didProviderRefreshFail(snapshots: QuotaSnapshot[]): boolean {
  return snapshots.some((snapshot) => snapshot.connectionState === "error");
}

export function isStaleClaudeSnapshot(
  snapshot: QuotaSnapshot,
  nowSeconds: number,
): boolean {
  return (
    snapshot.providerId === "claude" &&
    snapshot.connectionState === "connected" &&
    nowSeconds - snapshot.capturedAt > CLAUDE_STALE_AFTER_SECONDS
  );
}

export function getWorstTrustworthySeverity(
  snapshots: QuotaSnapshot[],
  nowSeconds: number,
): TraySeverity | undefined {
  let worstUsedPercent: number | undefined;
  for (const snapshot of snapshots) {
    if (
      snapshot.connectionState !== "connected" ||
      isStaleClaudeSnapshot(snapshot, nowSeconds)
    ) {
      continue;
    }
    for (const window of snapshot.windows) {
      worstUsedPercent =
        worstUsedPercent === undefined
          ? window.usedPercent
          : Math.max(worstUsedPercent, window.usedPercent);
    }
  }
  if (worstUsedPercent === undefined) {
    return undefined;
  }
  if (worstUsedPercent >= 90) {
    return "critical";
  }
  if (worstUsedPercent >= 80) {
    return "warning";
  }
  return "healthy";
}

function createWindowKey(
  providerId: string,
  windowMinutes: number,
  resetsAt: number,
): string {
  return `${providerId}:${windowMinutes}:${resetsAt}`;
}

function createThresholdKey(
  windowKey: string,
  threshold: QuotaNotificationThreshold,
): string {
  return `${windowKey}:${threshold}`;
}

function getResetTimeFromThresholdKey(key: string): number {
  return Number(key.split(":")[2] ?? 0);
}
