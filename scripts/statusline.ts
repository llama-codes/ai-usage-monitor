import {
  CLAUDE_CACHE_VERSION,
  resolveClaudeCachePath,
  writeClaudeQuotaCacheAtomically,
  type ClaudeCacheWindow,
  type ClaudeQuotaCache,
} from "../src/shared/claude-cache";

const MAX_INPUT_BYTES = 1024 * 1024;

type ParseResult =
  | { kind: "valid"; cache: ClaudeQuotaCache; display: string }
  | { kind: "absent"; display: string }
  | { kind: "invalid"; display: string };

export function parseClaudeStatusInput(
  input: string,
  capturedAt: number,
): ParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    return { kind: "invalid", display: "Claude usage unavailable" };
  }
  if (!isRecord(payload)) {
    return { kind: "invalid", display: "Claude usage unavailable" };
  }

  const rateLimits = payload.rate_limits;
  if (rateLimits === undefined || rateLimits === null) {
    return { kind: "absent", display: "Claude usage pending" };
  }
  if (!isRecord(rateLimits)) {
    return { kind: "invalid", display: "Claude usage unavailable" };
  }

  const fiveHour = parseWindow(rateLimits.five_hour);
  const sevenDay = parseWindow(rateLimits.seven_day);
  if (
    (rateLimits.five_hour !== undefined && !fiveHour) ||
    (rateLimits.seven_day !== undefined && !sevenDay) ||
    (!fiveHour && !sevenDay)
  ) {
    return { kind: "invalid", display: "Claude usage unavailable" };
  }

  const cache: ClaudeQuotaCache = {
    version: CLAUDE_CACHE_VERSION,
    capturedAt,
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  };
  const parts = [
    fiveHour ? `5h ${formatRemaining(fiveHour.usedPercent)} left` : null,
    sevenDay ? `7d ${formatRemaining(sevenDay.usedPercent)} left` : null,
  ].filter((part): part is string => part !== null);
  return {
    kind: "valid",
    cache,
    display: `Claude ${parts.join(" · ")}`,
  };
}

export async function runStatusLine(
  input: string,
  options: {
    capturedAt?: number;
    cachePath?: string;
  } = {},
): Promise<string> {
  const capturedAt = options.capturedAt ?? Math.floor(Date.now() / 1_000);
  const result = parseClaudeStatusInput(input, capturedAt);
  if (result.kind === "valid") {
    try {
      await writeClaudeQuotaCacheAtomically(
        options.cachePath ?? resolveClaudeCachePath(),
        result.cache,
      );
    } catch {
      return "Claude usage unavailable";
    }
  }
  return result.display;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let oversized = false;

    const finish = (value: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    process.stdin.on("data", (chunk: Buffer | string) => {
      if (oversized) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_INPUT_BYTES) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    });
    process.stdin.once("end", () =>
      finish(oversized ? "" : Buffer.concat(chunks).toString("utf8")),
    );
    process.stdin.once("error", () => finish(""));
    process.stdin.once("close", () =>
      finish(oversized ? "" : Buffer.concat(chunks).toString("utf8")),
    );
  });
}

async function main(): Promise<void> {
  const input = await readStdin();
  const display = await runStatusLine(input);
  process.stdout.write(`${display}\n`);
}

if (require.main === module) {
  void main()
    .catch(() => {
      process.stdout.write("Claude usage unavailable\n");
    })
    .finally(() => {
      process.exitCode = 0;
    });
}

function parseWindow(value: unknown): ClaudeCacheWindow | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isPercentage(value.used_percentage) ||
    !isUnixSeconds(value.resets_at)
  ) {
    return null;
  }
  return {
    usedPercent: value.used_percentage,
    resetsAt: value.resets_at,
  };
}

function formatRemaining(usedPercent: number): string {
  return `${Math.max(0, 100 - usedPercent).toFixed(
    Number.isInteger(usedPercent) ? 0 : 1,
  )}%`;
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
