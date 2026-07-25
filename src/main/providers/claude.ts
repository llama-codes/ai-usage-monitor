import fs from "node:fs";
import {
  parseClaudeQuotaCache,
  resolveClaudeCachePath,
  type ClaudeQuotaCache,
} from "../../shared/claude-cache";
import {
  isQuotaSnapshot,
  QUOTA_WINDOW_MINUTES,
  type QuotaSnapshot,
  type QuotaWindow,
} from "../../shared/contracts";

const MAX_CACHE_BYTES = 64 * 1024;

export class ClaudeQuotaProvider {
  constructor(
    private readonly cachePath: string = resolveClaudeCachePath(),
    private readonly now: () => number = Date.now,
  ) {}

  async readQuota(): Promise<QuotaSnapshot> {
    let raw: string;
    try {
      const stat = await fs.promises.stat(this.cachePath);
      if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) {
        return this.errorSnapshot();
      }
      raw = await fs.promises.readFile(this.cachePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          providerId: "claude",
          connectionState: "no-data-yet",
          windows: [],
          capturedAt: Math.floor(this.now() / 1_000),
          error:
            "Claude usage is waiting for a Claude Code statusline event.",
        };
      }
      return this.errorSnapshot();
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return this.errorSnapshot();
    }
    const cache = parseClaudeQuotaCache(value);
    if (!cache) {
      return this.errorSnapshot();
    }

    const snapshot: QuotaSnapshot = {
      providerId: "claude",
      connectionState: "connected",
      windows: mapClaudeCache(cache),
      capturedAt: cache.capturedAt,
    };
    return isQuotaSnapshot(snapshot) ? snapshot : this.errorSnapshot();
  }

  private errorSnapshot(): QuotaSnapshot {
    return {
      providerId: "claude",
      connectionState: "error",
      windows: [],
      capturedAt: Math.floor(this.now() / 1_000),
      error: "Claude usage cache is unavailable or incompatible.",
    };
  }
}

export function mapClaudeCache(cache: ClaudeQuotaCache): QuotaWindow[] {
  return [
    cache.fiveHour
      ? {
          label: "Five hours",
          usedPercent: cache.fiveHour.usedPercent,
          windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
          resetsAt: cache.fiveHour.resetsAt,
        }
      : null,
    cache.sevenDay
      ? {
          label: "Weekly",
          usedPercent: cache.sevenDay.usedPercent,
          windowMinutes: QUOTA_WINDOW_MINUTES.weekly,
          resetsAt: cache.sevenDay.resetsAt,
        }
      : null,
  ].filter((window): window is QuotaWindow => window !== null);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
