import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLAUDE_CACHE_RENAME_RETRY_DELAYS_MS,
  CLAUDE_CACHE_VERSION,
  parseClaudeQuotaCache,
  resolveClaudeCachePath,
  writeClaudeQuotaCacheAtomically,
} from "./claude-cache";
import {
  parseClaudeStatusInput,
  runStatusLine,
} from "../../scripts/statusline";

test("uses one explicit app-owned directory for hook and reader", () => {
  assert.equal(
    resolveClaudeCachePath(
      { AUM_DATA_DIR: "C:\\isolated\\AI Usage Monitor" },
      "win32",
    ),
    path.resolve("C:\\isolated\\AI Usage Monitor", "claude-quota-v1.json"),
  );
});

test("parses valid statusline windows into the versioned cache", () => {
  const result = parseClaudeStatusInput(
    JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 54, resets_at: 1_800_000_000 },
        seven_day: { used_percentage: 12.5, resets_at: 1_800_604_800 },
      },
    }),
    1_799_999_900,
  );
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") {
    return;
  }
  assert.deepEqual(result.cache, {
    version: CLAUDE_CACHE_VERSION,
    capturedAt: 1_799_999_900,
    fiveHour: { usedPercent: 54, resetsAt: 1_800_000_000 },
    sevenDay: { usedPercent: 12.5, resetsAt: 1_800_604_800 },
  });
  assert.equal(result.display, "Claude 5h 46% left · 7d 87.5% left");
});

test("absent and malformed limits never clobber a valid cache", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-claude-cache-"),
  );
  const cachePath = path.join(directory, "claude-quota-v1.json");
  try {
    const validInput = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 20, resets_at: 1_800_000_000 },
      },
    });
    assert.equal(
      await runStatusLine(validInput, {
        cachePath,
        capturedAt: 1_799_999_900,
      }),
      "Claude 5h 80% left",
    );
    const original = await fs.promises.readFile(cachePath);

    assert.equal(
      await runStatusLine(JSON.stringify({ model: "claude" }), { cachePath }),
      "Claude usage pending",
    );
    assert.deepEqual(await fs.promises.readFile(cachePath), original);

    assert.equal(
      await runStatusLine('{"rate_limits":{"five_hour":{"used_percentage":-1}}}', {
        cachePath,
      }),
      "Claude usage unavailable",
    );
    assert.deepEqual(await fs.promises.readFile(cachePath), original);
    assert.equal(await runStatusLine("", { cachePath }), "Claude usage unavailable");
    assert.deepEqual(await fs.promises.readFile(cachePath), original);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("atomic cache writes leave no temporary file", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-claude-atomic-"),
  );
  const cachePath = path.join(directory, "cache.json");
  try {
    const first = {
      version: CLAUDE_CACHE_VERSION,
      capturedAt: 100,
      fiveHour: { usedPercent: 10, resetsAt: 200 },
    } as const;
    const second = {
      version: CLAUDE_CACHE_VERSION,
      capturedAt: 101,
      sevenDay: { usedPercent: 20, resetsAt: 300 },
    } as const;
    const results = await Promise.allSettled([
      writeClaudeQuotaCacheAtomically(cachePath, first),
      writeClaudeQuotaCacheAtomically(cachePath, second),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );
    const parsed = parseClaudeQuotaCache(
      JSON.parse(await fs.promises.readFile(cachePath, "utf8")),
    );
    assert.ok(parsed);
    assert.ok(
      JSON.stringify(parsed) === JSON.stringify(first) ||
        JSON.stringify(parsed) === JSON.stringify(second),
    );
    assert.deepEqual(await fs.promises.readdir(directory), ["cache.json"]);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("retries bounded transient Windows replacement errors", async () => {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    const directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "aum-claude-retry-"),
    );
    const cachePath = path.join(directory, "cache.json");
    const delays: number[] = [];
    let renameCalls = 0;
    try {
      await writeClaudeQuotaCacheAtomically(
        cachePath,
        {
          version: CLAUDE_CACHE_VERSION,
          capturedAt: 100,
          fiveHour: { usedPercent: 10, resetsAt: 200 },
        },
        {
          platform: "win32",
          rename: async (source, destination) => {
            renameCalls += 1;
            if (renameCalls <= 2) {
              throw Object.assign(new Error(`injected ${code}`), { code });
            }
            await fs.promises.rename(source, destination);
          },
          delay: async (milliseconds) => {
            delays.push(milliseconds);
          },
        },
      );
      assert.equal(renameCalls, 3);
      assert.deepEqual(
        delays,
        CLAUDE_CACHE_RENAME_RETRY_DELAYS_MS.slice(0, 2),
      );
      assert.deepEqual(await fs.promises.readdir(directory), ["cache.json"]);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }
});

test("permanent rename failure is surfaced and cleans its unique temp file", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-claude-permanent-"),
  );
  const cachePath = path.join(directory, "cache.json");
  const injected = Object.assign(new Error("injected permanent rename failure"), {
    code: "EPERM",
  });
  let renameCalls = 0;
  try {
    await assert.rejects(
      writeClaudeQuotaCacheAtomically(
        cachePath,
        {
          version: CLAUDE_CACHE_VERSION,
          capturedAt: 100,
          fiveHour: { usedPercent: 10, resetsAt: 200 },
        },
        {
          platform: "win32",
          rename: async () => {
            renameCalls += 1;
            throw injected;
          },
          delay: async () => undefined,
          retryDelaysMs: [0, 0],
        },
      ),
      (error: unknown) => error === injected,
    );
    assert.equal(renameCalls, 3);
    assert.deepEqual(await fs.promises.readdir(directory), []);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("does not retry outside the narrow Windows transient-error policy", async () => {
  for (const fixture of [
    { platform: "linux" as const, code: "EPERM" },
    { platform: "win32" as const, code: "EINVAL" },
  ]) {
    const directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "aum-claude-no-retry-"),
    );
    const cachePath = path.join(directory, "cache.json");
    let renameCalls = 0;
    let delayCalls = 0;
    try {
      await assert.rejects(
        writeClaudeQuotaCacheAtomically(
          cachePath,
          {
            version: CLAUDE_CACHE_VERSION,
            capturedAt: 100,
            fiveHour: { usedPercent: 10, resetsAt: 200 },
          },
          {
            platform: fixture.platform,
            rename: async () => {
              renameCalls += 1;
              throw Object.assign(new Error("injected non-retryable error"), {
                code: fixture.code,
              });
            },
            delay: async () => {
              delayCalls += 1;
            },
          },
        ),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === fixture.code,
      );
      assert.equal(renameCalls, 1);
      assert.equal(delayCalls, 0);
      assert.deepEqual(await fs.promises.readdir(directory), []);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }
});

test("rejects incompatible caches without partial windows", () => {
  assert.equal(
    parseClaudeQuotaCache({
      version: 2,
      capturedAt: 100,
      fiveHour: { usedPercent: 10, resetsAt: 200 },
    }),
    null,
  );
  assert.equal(
    parseClaudeQuotaCache({
      version: 1,
      capturedAt: 100,
      fiveHour: { usedPercent: 101, resetsAt: 200 },
    }),
    null,
  );
});
