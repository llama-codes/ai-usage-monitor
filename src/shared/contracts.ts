export const QUOTA_WINDOW_MINUTES = {
  fiveHours: 300,
  weekly: 10_080,
} as const;

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

export type ForceRefreshRequest = {
  reason: "user";
};

export type QuotaUpdateListener = (snapshots: QuotaSnapshot[]) => void;

export type AIUsageMonitorAPI = {
  readQuota: () => Promise<QuotaSnapshot[]>;
  forceRefresh: (request: ForceRefreshRequest) => Promise<QuotaSnapshot[]>;
  onQuotaUpdated: (listener: QuotaUpdateListener) => () => void;
  quit: () => Promise<void>;
};

export const IPC_CHANNELS = {
  readQuota: "quota:read",
  forceRefresh: "quota:force-refresh",
  quotaUpdated: "quota:updated",
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
    (value.windowMinutes === QUOTA_WINDOW_MINUTES.fiveHours ||
      value.windowMinutes === QUOTA_WINDOW_MINUTES.weekly) &&
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

function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
