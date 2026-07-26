import { contextBridge, ipcRenderer } from "electron";
import type {
  AIUsageMonitorAPI,
  InstallClaudeHookRequest,
  ForceRefreshRequest,
  ProviderConnectionState,
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

function isQuotaSnapshotArray(value: unknown): value is QuotaSnapshot[] {
  return Array.isArray(value) && value.every(isQuotaSnapshot);
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

function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const api: AIUsageMonitorAPI = {
  readQuota: () => ipcRenderer.invoke(IPC_CHANNELS.readQuota),
  forceRefresh: (request: ForceRefreshRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.forceRefresh, request),
  onQuotaUpdated: (listener) => {
    if (typeof listener !== "function") {
      throw new TypeError("Quota update listener must be a function");
    }
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isQuotaSnapshotArray(value)) {
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

contextBridge.exposeInMainWorld("aiUsageMonitor", Object.freeze(api));
