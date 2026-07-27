import { contextBridge, ipcRenderer } from "electron";
import type {
  AIUsageMonitorAPI,
  InstallClaudeHookRequest,
  ForceRefreshRequest,
  ProviderConnectionState,
  QuotaForecast,
  QuotaForecastEvidence,
  QuotaReport,
  QuotaSnapshot,
  QuotaWindow,
} from "../shared/contracts";

// Sandboxed Electron preloads cannot require the emitted shared module at
// runtime without bundling. This type assertion keeps channel drift a compile
// error while leaving the preload as the single-file script the sandbox needs.
const IPC_CHANNELS = {
  readQuota: "quota:read",
  forceRefresh: "quota:force-refresh",
  quotaUpdated: "quota:updated",
  readClaudeSetup: "claude-setup:read",
  installClaudeHook: "claude-setup:install",
  quit: "app:quit",
} as const satisfies typeof import("../shared/contracts").IPC_CHANNELS;

function isQuotaReport(value: unknown): value is QuotaReport {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["snapshots", "forecasts"]) &&
    Array.isArray(value.snapshots) &&
    value.snapshots.every(isQuotaSnapshot) &&
    Array.isArray(value.forecasts) &&
    value.forecasts.every(isQuotaForecast) &&
    forecastsMatchSnapshots(value.forecasts, value.snapshots)
  );
}

function forecastsMatchSnapshots(
  forecasts: QuotaForecast[],
  snapshots: QuotaSnapshot[],
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

function isQuotaSnapshot(value: unknown): value is QuotaSnapshot {
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
  return (
    !Object.keys(value).some((key) => !validKeys.has(key)) &&
    typeof value.providerId === "string" &&
    value.providerId.length > 0 &&
    isConnectionState(value.connectionState) &&
    Array.isArray(value.windows) &&
    value.windows.every(isQuotaWindow) &&
    isUnixSeconds(value.capturedAt) &&
    (value.error === undefined || typeof value.error === "string")
  );
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
    (value.windowMinutes === 300 || value.windowMinutes === 10_080) &&
    isUnixSeconds(value.resetsAt)
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
  const validKeys =
    value.state === "projected-runout"
      ? [
          ...baseKeys,
          "confidence",
          "calculatedAt",
          "evidenceStartAt",
          "evidenceEndAt",
          "projectedRunoutAt",
        ]
      : value.state === "safe-through-reset"
        ? [
            ...baseKeys,
            "confidence",
            "calculatedAt",
            "evidenceStartAt",
            "evidenceEndAt",
          ]
        : value.state === "exhausted"
          ? [...baseKeys, "calculatedAt"]
          : value.state === "stale-paused" &&
              value.retainedEstimate !== undefined
            ? [...baseKeys, "retainedEstimate"]
            : baseKeys;
  if (
    !(
    hasExactKeys(value, validKeys) &&
    typeof value.providerId === "string" &&
    value.providerId.length > 0 &&
    (value.windowMinutes === 300 || value.windowMinutes === 10_080) &&
    isUnixSeconds(value.resetsAt) &&
    (value.state === "insufficient" ||
      value.state === "stale-paused" ||
      value.state === "safe-through-reset" ||
      value.state === "projected-runout" ||
      value.state === "exhausted" ||
      value.state === "unavailable-error") &&
    isForecastEvidence(value.evidence)
    )
  ) {
    return false;
  }
  if (
    value.state === "safe-through-reset" ||
    value.state === "projected-runout"
  ) {
    return (
      (value.confidence === "medium" || value.confidence === "high") &&
      isCalculatedProvenance(
        value,
        value.resetsAt,
        value.windowMinutes,
        value.confidence,
      ) &&
      (value.state !== "projected-runout" ||
        (isUnixSeconds(value.projectedRunoutAt) &&
          value.projectedRunoutAt > value.calculatedAt))
    );
  }
  if (value.state === "exhausted") {
    return (
      isEmptyForecastEvidence(value.evidence) &&
      isUnixSeconds(value.calculatedAt) &&
      value.calculatedAt < value.resetsAt
    );
  }
  if (value.state === "stale-paused") {
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
  return value.state === "insufficient" || isEmptyForecastEvidence(value.evidence);
}

function isCalculatedProvenance(
  value: Record<string, unknown>,
  resetsAt: number,
  windowMinutes: 300 | 10_080,
  confidence: "medium" | "high",
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
  windowMinutes: 300 | 10_080,
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
      (value.confidence === "medium" || value.confidence === "high") &&
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
      (value.confidence === "medium" || value.confidence === "high") &&
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
  windowMinutes: 300 | 10_080,
  confidence: "medium" | "high",
): boolean {
  const high = confidence === "high";
  return (
    value.sampleCount >= (high ? 10 : 6) &&
    value.distinctCaptureCount >= (high ? 10 : 6) &&
    value.increasePercent >= (high ? 10 : 5) &&
    value.spanSeconds >=
      (windowMinutes === 300
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

function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const api: AIUsageMonitorAPI = {
  readQuota: async () =>
    requireQuotaReport(
      await ipcRenderer.invoke(IPC_CHANNELS.readQuota),
    ),
  forceRefresh: async (request: ForceRefreshRequest) =>
    requireQuotaReport(
      await ipcRenderer.invoke(IPC_CHANNELS.forceRefresh, request),
    ),
  onQuotaUpdated: (listener) => {
    if (typeof listener !== "function") {
      throw new TypeError("Quota update listener must be a function");
    }
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isQuotaReport(value)) {
        listener(value);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.quotaUpdated, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.quotaUpdated, handler);
  },
  readClaudeSetup: () => ipcRenderer.invoke(IPC_CHANNELS.readClaudeSetup),
  installClaudeHook: (request: InstallClaudeHookRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.installClaudeHook, request),
  quit: () => ipcRenderer.invoke(IPC_CHANNELS.quit),
};

function requireQuotaReport(value: unknown): QuotaReport {
  if (!isQuotaReport(value)) {
    throw new TypeError("Main process returned an invalid quota report");
  }
  return value;
}

contextBridge.exposeInMainWorld("aiUsageMonitor", Object.freeze(api));
