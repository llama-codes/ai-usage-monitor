import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
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
    await Promise.all([
      writeClaudeQuotaCacheAtomically(cachePath, {
        version: CLAUDE_CACHE_VERSION,
        capturedAt: 100,
        fiveHour: { usedPercent: 10, resetsAt: 200 },
      }),
      writeClaudeQuotaCacheAtomically(cachePath, {
        version: CLAUDE_CACHE_VERSION,
        capturedAt: 101,
        sevenDay: { usedPercent: 20, resetsAt: 300 },
      }),
    ]);
    const parsed = parseClaudeQuotaCache(
      JSON.parse(await fs.promises.readFile(cachePath, "utf8")),
    );
    assert.ok(parsed);
    assert.equal((await fs.promises.readdir(directory)).length, 1);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
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
