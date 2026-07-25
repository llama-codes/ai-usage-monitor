import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  CodexAppServerClient,
  CodexProviderError,
  CodexQuotaProvider,
  mapCodexRateLimits,
  resolveCodexCommand,
  safeFailureCopy,
  type CodexServerProcess,
} from "./codex";

const RESET_5H = 2_000_000_000;
const RESET_WEEK = 2_000_500_000;

type FakeServer = {
  process: CodexServerProcess;
  requests: Array<Record<string, unknown>>;
  emitExit: () => void;
};

function createFakeServer(
  respond: (
    request: Record<string, unknown>,
    stdout: PassThrough,
  ) => void,
): FakeServer {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  let buffer = "";

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line) as Record<string, unknown>;
        requests.push(request);
        respond(request, stdout);
        newline = buffer.indexOf("\n");
      }
      callback();
    },
  });

  const process = emitter as unknown as CodexServerProcess;
  Object.assign(process, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    killed: false,
    kill: () => {
      if (process.killed) {
        return true;
      }
      process.killed = true;
      process.exitCode = 0;
      emitter.emit("exit", 0, null);
      return true;
    },
  });

  return {
    process,
    requests,
    emitExit: () => {
      process.exitCode = 1;
      emitter.emit("exit", 1, null);
    },
  };
}

function respondWith(
  stdout: PassThrough,
  id: unknown,
  result: unknown,
): void {
  stdout.write(`${JSON.stringify({ id, result })}\n`);
}

const bothWindowsResponse = {
  rateLimits: {
    primary: {
      usedPercent: 21,
      windowDurationMins: 10_080,
      resetsAt: RESET_WEEK,
    },
    secondary: {
      usedPercent: 9,
      windowDurationMins: 300,
      resetsAt: RESET_5H,
    },
  },
};

test("maps windows by duration instead of primary/secondary slot", () => {
  assert.deepEqual(mapCodexRateLimits(bothWindowsResponse), [
    {
      label: "Five hours",
      usedPercent: 9,
      windowMinutes: 300,
      resetsAt: RESET_5H,
    },
    {
      label: "Weekly",
      usedPercent: 21,
      windowMinutes: 10_080,
      resetsAt: RESET_WEEK,
    },
  ]);
});

test("accepts primary weekly with a null secondary", () => {
  assert.deepEqual(
    mapCodexRateLimits({
      rateLimits: {
        primary: bothWindowsResponse.rateLimits.primary,
        secondary: null,
      },
      rateLimitsByLimitId: {
        ignored: {
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: 1,
          },
        },
      },
    }),
    [
      {
        label: "Weekly",
        usedPercent: 21,
        windowMinutes: 10_080,
        resetsAt: RESET_WEEK,
      },
    ],
  );
});

test("omits unsupported, absent, and incomplete windows", () => {
  assert.deepEqual(
    mapCodexRateLimits({
      rateLimits: {
        primary: {
          usedPercent: 42,
          windowDurationMins: 60,
          resetsAt: RESET_5H,
        },
        secondary: null,
      },
    }),
    [],
  );
  assert.deepEqual(
    mapCodexRateLimits({
      rateLimits: {
        primary: {
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: null,
        },
      },
    }),
    [],
  );
});

for (const [name, response] of [
  [
    "percentage",
    {
      rateLimits: {
        primary: {
          usedPercent: 101,
          windowDurationMins: 300,
          resetsAt: RESET_5H,
        },
      },
    },
  ],
  [
    "duration",
    {
      rateLimits: {
        primary: {
          usedPercent: 10,
          windowDurationMins: "300",
          resetsAt: RESET_5H,
        },
      },
    },
  ],
  [
    "timestamp",
    {
      rateLimits: {
        primary: {
          usedPercent: 10,
          windowDurationMins: 300,
          resetsAt: "tomorrow",
        },
      },
    },
  ],
] as const) {
  test(`rejects invalid ${name}`, () => {
    assert.throws(
      () => mapCodexRateLimits(response),
      (error: unknown) =>
        error instanceof CodexProviderError &&
        error.kind === "incompatible-response",
    );
  });
}

test("reuses one initialized process and correlates requests", async () => {
  let server: FakeServer;
  server = createFakeServer((request, stdout) => {
    if (typeof request.id === "number") {
      respondWith(
        stdout,
        request.id,
        request.method === "initialize" ? {} : bothWindowsResponse,
      );
    }
  });
  let spawns = 0;
  const client = new CodexAppServerClient(() => {
    spawns += 1;
    return server.process;
  });

  assert.deepEqual(await client.readRateLimits(), bothWindowsResponse);
  assert.deepEqual(await client.readRateLimits(), bothWindowsResponse);
  assert.equal(spawns, 1);
  assert.deepEqual(
    server.requests.map((request) => request.method),
    [
      "initialize",
      "initialized",
      "account/rateLimits/read",
      "account/rateLimits/read",
    ],
  );
  assert.deepEqual(server.requests[0]?.params, {
    clientInfo: {
      name: "ai-usage-monitor",
      title: "AI Usage Monitor",
      version: "0.0.0",
    },
    capabilities: { experimentalApi: true },
  });
  assert.equal(server.requests[2]?.params, null);
  client.dispose();
});

test("respawns and initializes after app-server exit", async () => {
  const servers = [0, 1].map(() =>
    createFakeServer((request, stdout) => {
      if (typeof request.id === "number") {
        respondWith(
          stdout,
          request.id,
          request.method === "initialize" ? {} : bothWindowsResponse,
        );
      }
    }),
  );
  let spawnIndex = 0;
  const client = new CodexAppServerClient(
    () => servers[spawnIndex++]!.process,
  );

  await client.readRateLimits();
  servers[0]!.emitExit();
  await client.readRateLimits();
  assert.equal(spawnIndex, 2);
  assert.equal(servers[1]!.requests[0]?.method, "initialize");
  client.dispose();
});

test("maps JSON-RPC auth errors to safe signed-out copy", async () => {
  const server = createFakeServer((request, stdout) => {
    if (request.method === "initialize") {
      respondWith(stdout, request.id, {});
    } else if (request.method === "account/rateLimits/read") {
      stdout.write(
        `${JSON.stringify({
          id: request.id,
          error: { code: -32_000, message: "user is not logged in" },
        })}\n`,
      );
    }
  });
  const provider = new CodexQuotaProvider(
    new CodexAppServerClient(() => server.process),
    () => 1_700_000_000_000,
  );
  assert.deepEqual(await provider.readQuota(), {
    providerId: "codex",
    connectionState: "not-connected",
    windows: [],
    capturedAt: 1_700_000_000,
    error: safeFailureCopy("unauthenticated"),
  });
  provider.dispose();
});

test("times out, fails malformed output, and handles exit safely", async () => {
  const timeoutServer = createFakeServer((request, stdout) => {
    if (request.method === "initialize") {
      respondWith(stdout, request.id, {});
    }
  });
  const timeoutProvider = new CodexQuotaProvider(
    new CodexAppServerClient(() => timeoutServer.process, 10),
  );
  assert.equal(
    (await timeoutProvider.readQuota()).error,
    safeFailureCopy("timeout"),
  );
  timeoutProvider.dispose();

  const malformedServer = createFakeServer((request, stdout) => {
    if (request.method === "initialize") {
      respondWith(stdout, request.id, {});
    } else if (request.method === "account/rateLimits/read") {
      stdout.write("not-json\n");
    }
  });
  const malformedProvider = new CodexQuotaProvider(
    new CodexAppServerClient(() => malformedServer.process),
  );
  assert.equal(
    (await malformedProvider.readQuota()).error,
    safeFailureCopy("incompatible-response"),
  );
  malformedProvider.dispose();

  const exitServer = createFakeServer((request, _stdout) => {
    if (request.method === "initialize") {
      exitServer.emitExit();
    }
  });
  const exitProvider = new CodexQuotaProvider(
    new CodexAppServerClient(() => exitServer.process),
  );
  assert.equal(
    (await exitProvider.readQuota()).error,
    safeFailureCopy("server-failure"),
  );
  exitProvider.dispose();
});

test("maps a missing executable without leaking process details", async () => {
  const missing = Object.assign(new Error("sensitive path"), {
    code: "ENOENT",
  });
  const provider = new CodexQuotaProvider(
    new CodexAppServerClient(() => {
      throw missing;
    }),
  );
  assert.equal(
    (await provider.readQuota()).error,
    safeFailureCopy("binary-missing"),
  );
  provider.dispose();
});

test("Windows resolver fails safely when PATH has no Codex CLI", () => {
  assert.throws(
    () => resolveCodexCommand({ PATH: "" }, "win32", "x64"),
    (error: unknown) =>
      error instanceof CodexProviderError && error.kind === "binary-missing",
  );
});
