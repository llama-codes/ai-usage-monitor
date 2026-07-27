export const QUOTA_WINDOW_MINUTES = {
  fiveHours: 300,
  weekly: 10_080,
} as const;
export const CLAUDE_STALE_AFTER_SECONDS = 5 * 60;

export type QuotaWindowMinutes =
  (typeof QUOTA_WINDOW_MINUTES)[keyof typeof QUOTA_WINDOW_MINUTES];

export type ProviderConnectionState =
  | "connected"
  | "no-data-yet"
  | "not-connected"
  | "error"
  | "unsupported";

export type QuotaWindow = {
  label: string;
  usedPercent: number;
  windowMinutes: QuotaWindowMinutes;
  resetsAt: number;
};

export type QuotaSnapshot = {
  providerId: string;
  connectionState: ProviderConnectionState;
  windows: QuotaWindow[];
  capturedAt: number;
  error?: string;
};

export type QuotaForecastState =
  | "insufficient"
  | "stale-paused"
  | "safe-through-reset"
  | "projected-runout"
  | "exhausted"
  | "unavailable-error";

export type QuotaForecastConfidence = "medium" | "high";

export type QuotaForecastEvidence = {
  sampleCount: number;
  distinctCaptureCount: number;
  spanSeconds: number;
  increasePercent: number;
};

type QuotaForecastBase = {
  providerId: string;
  windowMinutes: QuotaWindowMinutes;
  resetsAt: number;
};

export type QuotaCalculatedForecastEstimate =
  | {
      state: "safe-through-reset";
      confidence: QuotaForecastConfidence;
      calculatedAt: number;
      evidenceStartAt: number;
      evidenceEndAt: number;
      evidence: QuotaForecastEvidence;
    }
  | {
      state: "projected-runout";
      confidence: QuotaForecastConfidence;
      calculatedAt: number;
      evidenceStartAt: number;
      evidenceEndAt: number;
      projectedRunoutAt: number;
      evidence: QuotaForecastEvidence;
    }
  | {
      state: "exhausted";
      calculatedAt: number;
      evidence: QuotaForecastEvidence;
    };

export type QuotaForecast =
  | (QuotaForecastBase & {
      state: "insufficient";
      evidence: QuotaForecastEvidence;
    })
  | (QuotaForecastBase & {
      state: "stale-paused";
      evidence: QuotaForecastEvidence;
      retainedEstimate?: QuotaCalculatedForecastEstimate;
    })
  | (QuotaForecastBase & QuotaCalculatedForecastEstimate)
  | (QuotaForecastBase & {
      state: "unavailable-error";
      evidence: QuotaForecastEvidence;
    });

export type QuotaTrendPoint = {
  capturedAt: number;
  usedPercent: number;
};

export type QuotaTrend = {
  providerId: string;
  windowMinutes: QuotaWindowMinutes;
  resetsAt: number;
  points: QuotaTrendPoint[];
};

export type QuotaReport = {
  generatedAt: number;
  snapshots: QuotaSnapshot[];
  forecasts: QuotaForecast[];
  trends: QuotaTrend[];
};

export type CurrentRiskWindow = {
  snapshot: QuotaSnapshot;
  window: QuotaWindow;
};

export function selectCurrentRiskWindow(
  snapshots: readonly QuotaSnapshot[],
  generatedAt: number,
): CurrentRiskWindow | undefined {
  let freshSelected: CurrentRiskWindow | undefined;
  let staleClaudeSelected: CurrentRiskWindow | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.connectionState !== "connected") {
      continue;
    }
    const isStaleClaude =
      snapshot.providerId === "claude" &&
      generatedAt - snapshot.capturedAt > CLAUDE_STALE_AFTER_SECONDS;
    for (const window of snapshot.windows) {
      if (window.resetsAt <= generatedAt) {
        continue;
      }
      const selected = isStaleClaude
        ? staleClaudeSelected
        : freshSelected;
      if (!selected || window.usedPercent > selected.window.usedPercent) {
        if (isStaleClaude) {
          staleClaudeSelected = { snapshot, window };
        } else {
          freshSelected = { snapshot, window };
        }
      }
    }
  }
  return freshSelected ?? staleClaudeSelected;
}

export type ForceRefreshRequest = {
  reason: "user";
};

export type InstallClaudeHookRequest = {
  confirmed: true;
};

export type ClaudeSetupState =
  | { status: "available" }
  | { status: "missing" }
  | { status: "installed-pending" }
  | { status: "conflict" }
  | { status: "error"; message: string };

export type QuotaUpdateListener = (report: QuotaReport) => void;

export type AIUsageMonitorAPI = {
  readQuota: () => Promise<QuotaReport>;
  forceRefresh: (request: ForceRefreshRequest) => Promise<QuotaReport>;
  onQuotaUpdated: (listener: QuotaUpdateListener) => () => void;
  readClaudeSetup: () => Promise<ClaudeSetupState>;
  installClaudeHook: (
    request: InstallClaudeHookRequest,
  ) => Promise<ClaudeSetupState>;
  quit: () => Promise<void>;
};

export const IPC_CHANNELS = {
  readQuota: "quota:read",
  forceRefresh: "quota:force-refresh",
  quotaUpdated: "quota:updated",
  readClaudeSetup: "claude-setup:read",
  installClaudeHook: "claude-setup:install",
  quit: "app:quit",
} as const;

export function isQuitRequestArguments(value: unknown[]): boolean {
  return value.length === 0;
}

export function isForceRefreshRequest(
  value: unknown,
): value is ForceRefreshRequest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "reason") &&
    value.reason === "user"
  );
}

export function isInstallClaudeHookRequest(
  value: unknown,
): value is InstallClaudeHookRequest {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "confirmed") &&
    value.confirmed === true
  );
}

export function isQuotaSnapshot(value: unknown): value is QuotaSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  const validKeys = new Set([
    "providerId",
    "connectionState",
    "windows",
    "capturedAt",
    "error",
  ]);
  if (Object.keys(value).some((key) => !validKeys.has(key))) {
    return false;
  }

  return (
    typeof value.providerId === "string" &&
    value.providerId.length > 0 &&
    isConnectionState(value.connectionState) &&
    Array.isArray(value.windows) &&
    value.windows.every(isQuotaWindow) &&
    isUnixSeconds(value.capturedAt) &&
    (value.error === undefined || typeof value.error === "string")
  );
}

export function isQuotaReport(value: unknown): value is QuotaReport {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "generatedAt",
      "snapshots",
      "forecasts",
      "trends",
    ]) ||
    !isUnixSeconds(value.generatedAt)
  ) {
    return false;
  }
  const generatedAt = value.generatedAt;
  return (
    Array.isArray(value.snapshots) &&
    value.snapshots.every(isQuotaSnapshot) &&
    value.snapshots.every(
      (snapshot) => snapshot.capturedAt <= generatedAt,
    ) &&
    Array.isArray(value.forecasts) &&
    value.forecasts.every(isQuotaForecast) &&
    forecastsMatchSnapshots(
      value.forecasts,
      value.snapshots,
      generatedAt,
    ) &&
    Array.isArray(value.trends) &&
    value.trends.length <= 1 &&
    value.trends.every(isQuotaTrend) &&
    trendsMatchSnapshots(
      value.trends,
      value.snapshots,
      generatedAt,
    )
  );
}

function trendsMatchSnapshots(
  trends: QuotaTrend[],
  snapshots: QuotaSnapshot[],
  generatedAt: number,
): boolean {
  const selected = selectCurrentRiskWindow(snapshots, generatedAt);
  if (trends.length === 0) {
    return true;
  }
  if (!selected) {
    return false;
  }
  const keys = new Set<string>();
  for (const trend of trends) {
    const key = `${trend.providerId}:${trend.windowMinutes}`;
    if (keys.has(key)) {
      return false;
    }
    keys.add(key);
    const snapshot = snapshots.find(
      (candidate) => candidate.providerId === trend.providerId,
    );
    const window = snapshot?.windows.find(
      (candidate) =>
        candidate.windowMinutes === trend.windowMinutes &&
        candidate.resetsAt === trend.resetsAt,
    );
    const latest = trend.points.at(-1);
    if (
      !snapshot ||
      snapshot.connectionState !== "connected" ||
      !window ||
      trend.providerId !== selected.snapshot.providerId ||
      trend.windowMinutes !== selected.window.windowMinutes ||
      trend.resetsAt !== selected.window.resetsAt ||
      !latest ||
      latest.capturedAt !== snapshot.capturedAt ||
      latest.usedPercent !== window.usedPercent ||
      trend.points.some(
        (point) =>
          point.capturedAt > snapshot.capturedAt ||
          point.capturedAt >= trend.resetsAt,
      )
    ) {
      return false;
    }
  }
  return true;
}

function isQuotaTrend(value: unknown): value is QuotaTrend {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "providerId",
      "windowMinutes",
      "resetsAt",
      "points",
    ]) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    !isQuotaWindowMinutes(value.windowMinutes) ||
    !isUnixSeconds(value.resetsAt) ||
    !Array.isArray(value.points) ||
    value.points.length === 0 ||
    value.points.length > 32
  ) {
    return false;
  }
  let previousCapturedAt = -1;
  for (const point of value.points) {
    if (
      !isRecord(point) ||
      !hasExactKeys(point, ["capturedAt", "usedPercent"]) ||
      !isUnixSeconds(point.capturedAt) ||
      point.capturedAt <= previousCapturedAt ||
      typeof point.usedPercent !== "number" ||
      !Number.isFinite(point.usedPercent) ||
      point.usedPercent < 0 ||
      point.usedPercent > 100
    ) {
      return false;
    }
    previousCapturedAt = point.capturedAt;
  }
  return true;
}

function forecastsMatchSnapshots(
  forecasts: QuotaForecast[],
  snapshots: QuotaSnapshot[],
  generatedAt: number,
): boolean {
  const keys = new Set<string>();
  for (const forecast of forecasts) {
    const key = `${forecast.providerId}:${forecast.windowMinutes}`;
    if (keys.has(key)) {
      return false;
    }
    keys.add(key);
    const snapshot = snapshots.find(
      (candidate) => candidate.providerId === forecast.providerId,
    );
    const window = snapshot?.windows.find(
      (candidate) =>
        candidate.windowMinutes === forecast.windowMinutes &&
        candidate.resetsAt === forecast.resetsAt,
    );
    if (
      !snapshot ||
      !window ||
      (forecast.state === "stale-paused" &&
        (snapshot.providerId !== "claude" ||
          generatedAt - snapshot.capturedAt <=
            CLAUDE_STALE_AFTER_SECONDS ||
          window.resetsAt <= generatedAt)) ||
      (forecast.state === "exhausted" &&
        (window.usedPercent < 100 ||
          window.resetsAt <= snapshot.capturedAt)) ||
      (forecast.state === "projected-runout" &&
        (forecast.projectedRunoutAt ?? forecast.resetsAt) >=
          forecast.resetsAt)
    ) {
      return false;
    }
  }
  return true;
}

function isQuotaForecast(value: unknown): value is QuotaForecast {
  if (!isRecord(value)) {
    return false;
  }
  const baseKeys = [
    "providerId",
    "windowMinutes",
    "resetsAt",
    "state",
    "evidence",
  ];
  const state = value.state;
  const validKeys =
    state === "projected-runout"
      ? [
          ...baseKeys,
          "confidence",
          "calculatedAt",
          "evidenceStartAt",
          "evidenceEndAt",
          "projectedRunoutAt",
        ]
      : state === "safe-through-reset"
        ? [
            ...baseKeys,
            "confidence",
            "calculatedAt",
            "evidenceStartAt",
            "evidenceEndAt",
          ]
        : state === "exhausted"
          ? [...baseKeys, "calculatedAt"]
          : state === "stale-paused" && value.retainedEstimate !== undefined
            ? [...baseKeys, "retainedEstimate"]
            : baseKeys;
  if (
    !(
    hasExactKeys(value, validKeys) &&
    typeof value.providerId === "string" &&
    value.providerId.length > 0 &&
    isQuotaWindowMinutes(value.windowMinutes) &&
    isUnixSeconds(value.resetsAt) &&
    isForecastState(state) &&
    isForecastEvidence(value.evidence)
    )
  ) {
    return false;
  }
  if (state === "safe-through-reset" || state === "projected-runout") {
    return (
      isForecastConfidence(value.confidence) &&
      isCalculatedProvenance(
        value,
        value.resetsAt,
        value.windowMinutes,
        value.confidence,
      ) &&
      (state !== "projected-runout" ||
        (isUnixSeconds(value.projectedRunoutAt) &&
          value.projectedRunoutAt > value.calculatedAt))
    );
  }
  if (state === "exhausted") {
    return (
      isEmptyForecastEvidence(value.evidence) &&
      isUnixSeconds(value.calculatedAt) &&
      value.calculatedAt < value.resetsAt
    );
  }
  if (state === "stale-paused") {
    return (
      isEmptyForecastEvidence(value.evidence) &&
      (value.retainedEstimate === undefined ||
        isRetainedEstimate(
          value.retainedEstimate,
          value.resetsAt,
          value.windowMinutes,
        ))
    );
  }
  return state === "insufficient" || isEmptyForecastEvidence(value.evidence);
}

function isCalculatedProvenance(
  value: Record<string, unknown>,
  resetsAt: number,
  windowMinutes: QuotaWindowMinutes,
  confidence: QuotaForecastConfidence,
): value is Record<string, unknown> & {
  calculatedAt: number;
  evidenceStartAt: number;
  evidenceEndAt: number;
} {
  return (
    isUnixSeconds(value.calculatedAt) &&
    isUnixSeconds(value.evidenceStartAt) &&
    isUnixSeconds(value.evidenceEndAt) &&
    value.evidenceStartAt <= value.evidenceEndAt &&
    value.evidenceEndAt <= value.calculatedAt &&
    value.calculatedAt < resetsAt &&
    isForecastEvidence(value.evidence) &&
    meetsConfidenceEvidence(value.evidence, windowMinutes, confidence) &&
    value.evidence.spanSeconds ===
      value.evidenceEndAt - value.evidenceStartAt
  );
}

function isRetainedEstimate(
  value: unknown,
  resetsAt: number,
  windowMinutes: QuotaWindowMinutes,
): boolean {
  if (!isRecord(value) || !isForecastEvidence(value.evidence)) {
    return false;
  }
  const baseKeys = ["state", "calculatedAt", "evidence"];
  if (value.state === "exhausted") {
    return (
      hasExactKeys(value, baseKeys) &&
      isEmptyForecastEvidence(value.evidence) &&
      isUnixSeconds(value.calculatedAt) &&
      value.calculatedAt < resetsAt
    );
  }
  const calculatedKeys = [
    ...baseKeys,
    "confidence",
    "evidenceStartAt",
    "evidenceEndAt",
  ];
  if (value.state === "safe-through-reset") {
    return (
      hasExactKeys(value, calculatedKeys) &&
      isForecastConfidence(value.confidence) &&
      isCalculatedProvenance(
        value,
        resetsAt,
        windowMinutes,
        value.confidence,
      )
    );
  }
  if (value.state === "projected-runout") {
    return (
      hasExactKeys(value, [...calculatedKeys, "projectedRunoutAt"]) &&
      isForecastConfidence(value.confidence) &&
      isCalculatedProvenance(
        value,
        resetsAt,
        windowMinutes,
        value.confidence,
      ) &&
      isUnixSeconds(value.projectedRunoutAt) &&
      value.projectedRunoutAt > value.calculatedAt &&
      value.projectedRunoutAt < resetsAt
    );
  }
  return false;
}

function meetsConfidenceEvidence(
  value: QuotaForecastEvidence,
  windowMinutes: QuotaWindowMinutes,
  confidence: QuotaForecastConfidence,
): boolean {
  const high = confidence === "high";
  return (
    value.sampleCount >= (high ? 10 : 6) &&
    value.distinctCaptureCount >= (high ? 10 : 6) &&
    value.increasePercent >= (high ? 10 : 5) &&
    value.spanSeconds >=
      (windowMinutes === QUOTA_WINDOW_MINUTES.fiveHours
        ? (high ? 60 : 30) * 60
        : (high ? 24 : 12) * 60 * 60)
  );
}

function isForecastEvidence(
  value: unknown,
): value is QuotaForecastEvidence {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "sampleCount",
      "distinctCaptureCount",
      "spanSeconds",
      "increasePercent",
    ]) &&
    isBoundedInteger(value.sampleCount, 0, 64) &&
    isBoundedInteger(
      value.distinctCaptureCount,
      0,
      value.sampleCount as number,
    ) &&
    isUnixSeconds(value.spanSeconds) &&
    typeof value.increasePercent === "number" &&
    Number.isFinite(value.increasePercent) &&
    value.increasePercent >= 0 &&
    value.increasePercent <= 100
  );
}

function isEmptyForecastEvidence(value: QuotaForecastEvidence): boolean {
  return (
    value.sampleCount === 0 &&
    value.distinctCaptureCount === 0 &&
    value.spanSeconds === 0 &&
    value.increasePercent === 0
  );
}

function isForecastState(value: unknown): value is QuotaForecastState {
  return (
    value === "insufficient" ||
    value === "stale-paused" ||
    value === "safe-through-reset" ||
    value === "projected-runout" ||
    value === "exhausted" ||
    value === "unavailable-error"
  );
}

function isForecastConfidence(
  value: unknown,
): value is QuotaForecastConfidence {
  return value === "medium" || value === "high";
}

function isQuotaWindow(value: unknown): value is QuotaWindow {
  if (!isRecord(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return (
    keys.length === 4 &&
    keys.every((key) =>
      ["label", "usedPercent", "windowMinutes", "resetsAt"].includes(key),
    ) &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    typeof value.usedPercent === "number" &&
    Number.isFinite(value.usedPercent) &&
    value.usedPercent >= 0 &&
    value.usedPercent <= 100 &&
    isQuotaWindowMinutes(value.windowMinutes) &&
    isUnixSeconds(value.resetsAt)
  );
}

function isQuotaWindowMinutes(value: unknown): value is QuotaWindowMinutes {
  return (
    value === QUOTA_WINDOW_MINUTES.fiveHours ||
    value === QUOTA_WINDOW_MINUTES.weekly
  );
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key))
  );
}

function isConnectionState(value: unknown): value is ProviderConnectionState {
  return (
    value === "connected" ||
    value === "no-data-yet" ||
    value === "not-connected" ||
    value === "error" ||
    value === "unsupported"
  );
}

function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
