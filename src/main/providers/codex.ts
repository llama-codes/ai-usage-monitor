import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  QUOTA_WINDOW_MINUTES,
  isQuotaSnapshot,
  type QuotaSnapshot,
  type QuotaWindow,
  type QuotaWindowMinutes,
} from "../../shared/contracts";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_STDOUT_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 4_096;

export type CodexFailureKind =
  | "binary-missing"
  | "unauthenticated"
  | "timeout"
  | "incompatible-response"
  | "server-failure";

export class CodexProviderError extends Error {
  constructor(
    readonly kind: CodexFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "CodexProviderError";
  }
}

export type CodexServerProcess = Pick<
  ChildProcessWithoutNullStreams,
  "stdin" | "stdout" | "stderr" | "once" | "on" | "kill"
> & {
  exitCode: number | null;
  killed: boolean;
};

export type SpawnCodexServer = () => CodexServerProcess;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: CodexProviderError) => void;
  timeout: NodeJS.Timeout;
};

type JsonRpcError = {
  code?: unknown;
  message?: unknown;
};

type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: JsonRpcError;
};

export class CodexAppServerClient {
  private child: CodexServerProcess | null = null;
  private initialized: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private stderrTail = "";
  private disposed = false;

  constructor(
    private readonly spawnServer: SpawnCodexServer = spawnCodexAppServer,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async readRateLimits(): Promise<unknown> {
    await this.ensureInitialized();
    return this.request("account/rateLimits/read", null);
  }

  dispose(): void {
    this.disposed = true;
    this.initialized = null;
    this.failPending(
      new CodexProviderError(
        "server-failure",
        "Codex app-server was disposed.",
      ),
    );
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) {
      child.kill();
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.disposed) {
      throw new CodexProviderError(
        "server-failure",
        "Codex app-server client is closed.",
      );
    }
    if (!this.initialized) {
      this.initialized = this.initialize().catch((error: unknown) => {
        this.initialized = null;
        const child = this.child;
        this.child = null;
        if (child && child.exitCode === null && !child.killed) {
          child.kill();
        }
        throw normalizeProviderError(error);
      });
    }
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    this.startChild();
    await this.request("initialize", {
      clientInfo: {
        name: "ai-usage-monitor",
        title: "AI Usage Monitor",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    await this.notify("initialized");
  }

  private startChild(): void {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return;
    }

    let child: CodexServerProcess;
    try {
      child = this.spawnServer();
    } catch (error) {
      throw classifySpawnError(error);
    }
    this.child = child;
    this.stdoutBuffer = "";
    this.stderrTail = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.acceptStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    child.once("error", (error) => {
      if (this.child === child) {
        this.handleChildFailure(classifySpawnError(error));
      }
    });
    child.once("exit", () => {
      if (this.child === child) {
        this.handleChildFailure(
          new CodexProviderError(
            "server-failure",
            "Codex app-server exited before completing the request.",
          ),
        );
      }
    });
  }

  private handleChildFailure(error: CodexProviderError): void {
    this.child = null;
    this.initialized = null;
    this.stdoutBuffer = "";
    this.stderrTail = "";
    this.failPending(error);
  }

  private acceptStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_STDOUT_LINE_BYTES) {
      this.rejectIncompatible("Codex emitted an oversized protocol line.");
      return;
    }

    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trimEnd();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.acceptLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private acceptLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.rejectIncompatible("Codex emitted malformed JSON-RPC.");
      return;
    }

    if (!isJsonRpcResponse(message)) {
      if (
        isRecord(message) &&
        Object.hasOwn(message, "id") &&
        (Object.hasOwn(message, "result") ||
          Object.hasOwn(message, "error"))
      ) {
        this.rejectIncompatible("Codex emitted a malformed JSON-RPC response.");
        return;
      }
      // Notifications and server-originated messages are irrelevant to this
      // read-only adapter. Only malformed responses with a known id fail.
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);

    if (message.error !== undefined) {
      pending.reject(classifyJsonRpcError(message.error));
      return;
    }
    if (!Object.hasOwn(message, "result")) {
      pending.reject(
        new CodexProviderError(
          "incompatible-response",
          "Codex returned a response without a result.",
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private rejectIncompatible(message: string): void {
    const error = new CodexProviderError("incompatible-response", message);
    this.failPending(error);
    const child = this.child;
    this.child = null;
    this.initialized = null;
    if (child && child.exitCode === null && !child.killed) {
      child.kill();
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) {
      return Promise.reject(
        new CodexProviderError(
          "server-failure",
          "Codex app-server is not running.",
        ),
      );
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new CodexProviderError(
          "timeout",
          "Codex app-server request timed out.",
        );
        const timedOutChild = this.child;
        this.child = null;
        this.initialized = null;
        this.failPending(error);
        if (
          timedOutChild &&
          timedOutChild.exitCode === null &&
          !timedOutChild.killed
        ) {
          timedOutChild.kill();
        }
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });

      const line = `${JSON.stringify({ id, method, params })}\n`;
      child.stdin.write(line, (error) => {
        if (!error) {
          return;
        }
        const request = this.pending.get(id);
        if (!request) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(request.timeout);
        request.reject(
          new CodexProviderError(
            "server-failure",
            "Could not write to Codex app-server.",
          ),
        );
      });
    });
  }

  private notify(method: string): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) {
      return Promise.reject(
        new CodexProviderError(
          "server-failure",
          "Codex app-server is not running.",
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify({ method })}\n`, (error) => {
        if (error) {
          reject(
            new CodexProviderError(
              "server-failure",
              "Could not write to Codex app-server.",
            ),
          );
        } else {
          resolve();
        }
      });
    });
  }

  private failPending(error: CodexProviderError): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}

export class CodexQuotaProvider {
  constructor(
    private readonly client: Pick<
      CodexAppServerClient,
      "readRateLimits" | "dispose"
    > = new CodexAppServerClient(),
    private readonly now: () => number = Date.now,
  ) {}

  async readQuota(): Promise<QuotaSnapshot> {
    const capturedAt = Math.floor(this.now() / 1_000);
    try {
      const result = await this.client.readRateLimits();
      const snapshot: QuotaSnapshot = {
        providerId: "codex",
        connectionState: "connected",
        windows: mapCodexRateLimits(result),
        capturedAt,
      };
      if (!isQuotaSnapshot(snapshot)) {
        throw new CodexProviderError(
          "incompatible-response",
          "Mapped Codex quota failed the shared contract.",
        );
      }
      return snapshot;
    } catch (error) {
      const normalized = normalizeProviderError(error);
      return {
        providerId: "codex",
        connectionState: "not-connected",
        windows: [],
        capturedAt,
        error: safeFailureCopy(normalized.kind),
      };
    }
  }

  dispose(): void {
    this.client.dispose();
  }
}

export function mapCodexRateLimits(result: unknown): QuotaWindow[] {
  if (!isRecord(result) || !isRecord(result.rateLimits)) {
    throw new CodexProviderError(
      "incompatible-response",
      "Codex rate-limit response is missing rateLimits.",
    );
  }

  const windows = new Map<QuotaWindowMinutes, QuotaWindow>();
  for (const candidate of [
    result.rateLimits.primary,
    result.rateLimits.secondary,
  ]) {
    if (candidate === null || candidate === undefined) {
      continue;
    }
    if (!isRecord(candidate)) {
      throw new CodexProviderError(
        "incompatible-response",
        "Codex returned a malformed rate-limit window.",
      );
    }

    const duration = candidate.windowDurationMins;
    if (
      duration !== QUOTA_WINDOW_MINUTES.fiveHours &&
      duration !== QUOTA_WINDOW_MINUTES.weekly
    ) {
      if (duration !== null && duration !== undefined && !isInteger(duration)) {
        throw new CodexProviderError(
          "incompatible-response",
          "Codex returned an invalid window duration.",
        );
      }
      continue;
    }

    if (
      !isInteger(candidate.usedPercent) ||
      candidate.usedPercent < 0 ||
      candidate.usedPercent > 100
    ) {
      throw new CodexProviderError(
        "incompatible-response",
        "Codex returned an invalid usage percentage.",
      );
    }
    if (candidate.resetsAt === null || candidate.resetsAt === undefined) {
      continue;
    }
    if (!isInteger(candidate.resetsAt) || candidate.resetsAt < 0) {
      throw new CodexProviderError(
        "incompatible-response",
        "Codex returned an invalid reset timestamp.",
      );
    }
    if (windows.has(duration)) {
      throw new CodexProviderError(
        "incompatible-response",
        "Codex returned a duplicate quota duration.",
      );
    }

    windows.set(duration, {
      label:
        duration === QUOTA_WINDOW_MINUTES.fiveHours
          ? "Five hours"
          : "Weekly",
      usedPercent: candidate.usedPercent,
      windowMinutes: duration,
      resetsAt: candidate.resetsAt,
    });
  }

  return [
    QUOTA_WINDOW_MINUTES.fiveHours,
    QUOTA_WINDOW_MINUTES.weekly,
  ].flatMap((duration) => {
    const window = windows.get(duration);
    return window ? [window] : [];
  });
}

export function safeFailureCopy(kind: CodexFailureKind): string {
  switch (kind) {
    case "binary-missing":
      return "Codex CLI was not found. Install it and restart the app.";
    case "unauthenticated":
      return "Codex is signed out. Run codex login, then refresh.";
    case "timeout":
      return "Codex did not respond in time.";
    case "incompatible-response":
      return "Codex returned an incompatible rate-limit response.";
    case "server-failure":
      return "Codex app-server could not read usage.";
  }
}

export function spawnCodexAppServer(): CodexServerProcess {
  const command = resolveCodexCommand();
  return spawn(command.executable, [...command.args, "app-server"], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  }) as CodexServerProcess;
}

export function resolveCodexCommand(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): { executable: string; args: string[] } {
  const pathValue = environment.PATH ?? environment.Path ?? "";
  const directories = pathValue.split(path.delimiter).filter(Boolean);

  if (platform !== "win32") {
    for (const directory of directories) {
      const executable = path.join(directory, "codex");
      if (isFile(executable)) {
        return { executable, args: [] };
      }
    }
    throw missingBinaryError();
  }

  for (const directory of directories) {
    const executable = path.join(directory, "codex.exe");
    if (isFile(executable)) {
      return { executable, args: [] };
    }
  }

  const packageName =
    architecture === "arm64"
      ? "codex-win32-arm64"
      : architecture === "x64"
        ? "codex-win32-x64"
        : null;
  const target =
    architecture === "arm64"
      ? "aarch64-pc-windows-msvc"
      : architecture === "x64"
        ? "x86_64-pc-windows-msvc"
        : null;
  if (!packageName || !target) {
    throw missingBinaryError();
  }

  for (const directory of directories) {
    const shim = path.join(directory, "codex.cmd");
    if (!isFile(shim)) {
      continue;
    }
    const executable = path.join(
      directory,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      packageName,
      "vendor",
      target,
      "bin",
      "codex.exe",
    );
    if (isFile(executable)) {
      return { executable, args: [] };
    }
  }

  throw missingBinaryError();
}

function classifySpawnError(error: unknown): CodexProviderError {
  if (
    isRecord(error) &&
    error.code === "ENOENT"
  ) {
    return missingBinaryError();
  }
  return new CodexProviderError(
    "server-failure",
    "Codex app-server could not be started.",
  );
}

function classifyJsonRpcError(error: JsonRpcError): CodexProviderError {
  const message = typeof error.message === "string" ? error.message : "";
  if (
    /\b(auth|authentication|authorization|credentials?|forbidden|login|logged[ -]?(?:in|out)|sign[ -]?in|unauthorized)\b/i.test(
      message,
    )
  ) {
    return new CodexProviderError(
      "unauthenticated",
      "Codex account is unauthenticated.",
    );
  }
  return new CodexProviderError(
    "server-failure",
    "Codex app-server returned an error.",
  );
}

function normalizeProviderError(error: unknown): CodexProviderError {
  if (error instanceof CodexProviderError) {
    return error;
  }
  return new CodexProviderError(
    "server-failure",
    "Codex provider failed unexpectedly.",
  );
}

function missingBinaryError(): CodexProviderError {
  return new CodexProviderError(
    "binary-missing",
    "Codex CLI executable was not found.",
  );
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return (
    isRecord(value) &&
    isInteger(value.id) &&
    (Object.hasOwn(value, "result") ||
      (Object.hasOwn(value, "error") && isRecord(value.error)))
  );
}

function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
