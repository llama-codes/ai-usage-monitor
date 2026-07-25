import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const CLAUDE_CACHE_VERSION = 1;
export const CLAUDE_CACHE_FILE = "claude-quota-v1.json";
export const AI_USAGE_MONITOR_DATA_DIRECTORY = "AIUsageMonitor";

export type ClaudeCacheWindow = {
  usedPercent: number;
  resetsAt: number;
};

export type ClaudeQuotaCache = {
  version: typeof CLAUDE_CACHE_VERSION;
  capturedAt: number;
  fiveHour?: ClaudeCacheWindow;
  sevenDay?: ClaudeCacheWindow;
};

export function resolveAIUsageMonitorDataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = environment.AUM_DATA_DIR;
  if (explicit) {
    return path.resolve(explicit);
  }

  if (platform === "win32") {
    const localAppData =
      environment.LOCALAPPDATA ??
      (environment.USERPROFILE
        ? path.join(environment.USERPROFILE, "AppData", "Local")
        : undefined);
    if (!localAppData) {
      throw new Error("Local application data directory is unavailable.");
    }
    return path.join(localAppData, AI_USAGE_MONITOR_DATA_DIRECTORY);
  }

  const base =
    environment.XDG_DATA_HOME ??
    (environment.HOME
      ? path.join(environment.HOME, ".local", "share")
      : undefined);
  if (!base) {
    throw new Error("Application data directory is unavailable.");
  }
  return path.join(base, "ai-usage-monitor");
}

export function resolveClaudeCachePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(
    resolveAIUsageMonitorDataDirectory(environment, platform),
    CLAUDE_CACHE_FILE,
  );
}

export function parseClaudeQuotaCache(value: unknown): ClaudeQuotaCache | null {
  if (!isRecord(value)) {
    return null;
  }

  const allowed = new Set(["version", "capturedAt", "fiveHour", "sevenDay"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return null;
  }
  if (
    value.version !== CLAUDE_CACHE_VERSION ||
    !isUnixSeconds(value.capturedAt)
  ) {
    return null;
  }

  const fiveHour = parseCacheWindow(value.fiveHour);
  const sevenDay = parseCacheWindow(value.sevenDay);
  if (
    (value.fiveHour !== undefined && !fiveHour) ||
    (value.sevenDay !== undefined && !sevenDay) ||
    (!fiveHour && !sevenDay)
  ) {
    return null;
  }

  return {
    version: CLAUDE_CACHE_VERSION,
    capturedAt: value.capturedAt,
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  };
}

export async function writeClaudeQuotaCacheAtomically(
  cachePath: string,
  cache: ClaudeQuotaCache,
): Promise<void> {
  const parsed = parseClaudeQuotaCache(cache);
  if (!parsed) {
    throw new TypeError("Invalid Claude cache.");
  }

  const directory = path.dirname(cachePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(cachePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.promises.mkdir(directory, { recursive: true });
  try {
    await fs.promises.writeFile(
      temporaryPath,
      `${JSON.stringify(parsed)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await fs.promises.rename(temporaryPath, cachePath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseCacheWindow(value: unknown): ClaudeCacheWindow | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "usedPercent") ||
    !Object.hasOwn(value, "resetsAt") ||
    !isPercentage(value.usedPercent) ||
    !isUnixSeconds(value.resetsAt)
  ) {
    return null;
  }
  return {
    usedPercent: value.usedPercent,
    resetsAt: value.resetsAt,
  };
}

function isPercentage(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
