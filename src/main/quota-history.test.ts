import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FileQuotaHistoryStore,
  MemoryQuotaHistoryStore,
  QUOTA_HISTORY_FILE,
  QUOTA_HISTORY_BACKUP_FILE,
  QUOTA_HISTORY_CORRUPT_PREFIX,
  QUOTA_HISTORY_DIRECTORY,
  QUOTA_HISTORY_MAX_FILE_BYTES,
  QUOTA_HISTORY_MAX_SAMPLE_AGE_SECONDS,
  QUOTA_HISTORY_MAX_SAMPLES_PER_SERIES,
  QUOTA_HISTORY_MAX_TOTAL_SAMPLES,
  QUOTA_HISTORY_RENAME_RETRY_DELAYS_MS,
  QUOTA_HISTORY_VERSION,
  QuotaHistoryStoreError,
  parseQuotaHistoryDocument,
  resolveQuotaHistoryPath,
  type FileQuotaHistoryStoreOptions,
  type QuotaHistoryStore,
} from "./quota-history";
import {
  QUOTA_WINDOW_MINUTES,
  type ProviderConnectionState,
  type QuotaSnapshot,
  type QuotaWindowMinutes,
} from "../shared/contracts";

const NOW = 1_800_000_000;

function snapshot(options: {
  providerId?: string;
  connectionState?: ProviderConnectionState;
  capturedAt?: number;
  usedPercent?: number;
  windowMinutes?: QuotaWindowMinutes;
  resetsAt?: number;
} = {}): QuotaSnapshot {
  const connectionState = options.connectionState ?? "connected";
  return {
    providerId: options.providerId ?? "codex",
    connectionState,
    capturedAt: options.capturedAt ?? NOW,
    windows:
      connectionState === "connected"
        ? [
            {
              label: "Quota",
              usedPercent: options.usedPercent ?? 20,
              windowMinutes:
                options.windowMinutes ?? QUOTA_WINDOW_MINUTES.fiveHours,
              resetsAt: options.resetsAt ?? NOW + 3_600,
            },
          ]
        : [],
  };
}

function fileOperations(): NonNullable<
  FileQuotaHistoryStoreOptions["operations"]
> {
  return {
    mkdir: fs.promises.mkdir.bind(fs.promises),
    open: fs.promises.open.bind(fs.promises),
    readFile: fs.promises.readFile.bind(fs.promises),
    readdir: fs.promises.readdir.bind(fs.promises),
    rename: fs.promises.rename.bind(fs.promises),
    rm: fs.promises.rm.bind(fs.promises),
  };
}

test("validates the strict bounded versioned history schema", () => {
  const valid = {
    version: QUOTA_HISTORY_VERSION,
    segments: [
      {
        providerId: "codex",
        windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
        resetsAt: NOW + 3_600,
        samples: [
          { capturedAt: NOW, observedAt: NOW, usedPercent: 20 },
          {
            capturedAt: NOW + 60,
            observedAt: NOW + 60,
            usedPercent: 21,
          },
        ],
      },
    ],
  };
  assert.deepEqual(parseQuotaHistoryDocument(valid), valid);
  for (const invalid of [
    { ...valid, version: 2 },
    { ...valid, unexpected: true },
    {
      ...valid,
      segments: [{ ...valid.segments[0], providerId: "unknown" }],
    },
    {
      ...valid,
      segments: [{ ...valid.segments[0], windowMinutes: 60 }],
    },
    {
      ...valid,
      segments: [
        {
          ...valid.segments[0],
          samples: [
            { capturedAt: NOW, observedAt: NOW, usedPercent: 101 },
          ],
        },
      ],
    },
    {
      ...valid,
      segments: [
        {
          ...valid.segments[0],
          samples: [
            {
              capturedAt: NOW + 60,
              observedAt: NOW + 60,
              usedPercent: 21,
            },
            { capturedAt: NOW, observedAt: NOW, usedPercent: 20 },
          ],
        },
      ],
    },
    {
      ...valid,
      segments: [
        {
          ...valid.segments[0],
          samples: [
            {
              capturedAt: NOW + 1,
              observedAt: NOW,
              usedPercent: 20,
            },
          ],
        },
      ],
    },
    {
      ...valid,
      segments: [
        {
          ...valid.segments[0],
          samples: [
            {
              capturedAt: NOW + 3_600,
              observedAt: NOW + 3_600,
              usedPercent: 20,
            },
          ],
        },
      ],
    },
    { ...valid, segments: [valid.segments[0], valid.segments[0]] },
  ]) {
    assert.equal(parseQuotaHistoryDocument(invalid, NOW + 60), null);
  }
  assert.equal(
    parseQuotaHistoryDocument(
      {
        ...valid,
        segments: [
          {
            ...valid.segments[0],
            samples: [
              {
                capturedAt: NOW + 1,
                observedAt: NOW + 1,
                usedPercent: 20,
              },
            ],
          },
        ],
      },
      NOW,
    ),
    null,
  );
  assert.equal(
    QUOTA_HISTORY_MAX_TOTAL_SAMPLES,
    QUOTA_HISTORY_MAX_SAMPLES_PER_SERIES * 4,
  );
});

test("records only trustworthy current connected windows", async () => {
  const store = new MemoryQuotaHistoryStore();
  await store.append(
    [
      snapshot(),
      snapshot({ connectionState: "error" }),
      snapshot({ providerId: "unknown" }),
      snapshot({ resetsAt: NOW }),
      snapshot({ providerId: "claude", capturedAt: NOW - 301 }),
    ],
    NOW,
  );
  assert.deepEqual(await store.readCurrent(NOW), [
    {
      providerId: "codex",
      windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
      resetsAt: NOW + 3_600,
      samples: [{ capturedAt: NOW, observedAt: NOW, usedPercent: 20 }],
    },
  ]);
});

test("deduplicates unchanged Claude reads and checkpoints unchanged Codex every fifteen minutes", async () => {
  const store = new MemoryQuotaHistoryStore();
  const claude = snapshot({ providerId: "claude" });
  await Promise.all([
    store.append([claude], NOW),
    store.append([claude], NOW + 60),
    store.append([claude], NOW + 120),
  ]);
  assert.deepEqual((await store.readCurrent(NOW + 120))[0]?.samples, [
    { capturedAt: NOW, observedAt: NOW, usedPercent: 20 },
  ]);

  await store.append(
    [snapshot({ capturedAt: NOW + 60, usedPercent: 20 })],
    NOW + 60,
  );
  await store.append(
    [snapshot({ capturedAt: NOW + 120, usedPercent: 21 })],
    NOW + 120,
  );
  await store.append(
    [snapshot({ capturedAt: NOW + 180, usedPercent: 21 })],
    NOW + 180,
  );
  await store.append(
    [snapshot({ capturedAt: NOW + 120, usedPercent: 21 })],
    NOW + 1_020,
  );
  const codex = (await store.readCurrent(NOW + 1_020)).find(
    (segment) => segment.providerId === "codex",
  );
  assert.deepEqual(codex?.samples, [
    { capturedAt: NOW + 60, observedAt: NOW + 60, usedPercent: 20 },
    { capturedAt: NOW + 120, observedAt: NOW + 120, usedPercent: 21 },
    {
      capturedAt: NOW + 120,
      observedAt: NOW + 1_020,
      usedPercent: 21,
    },
  ]);
});

test("reset changes create segments and expired cycles cannot be read or seed new history", async () => {
  const store = new MemoryQuotaHistoryStore();
  await store.append([snapshot({ resetsAt: NOW + 3_600 })], NOW);
  await store.append(
    [
      snapshot({
        capturedAt: NOW + 60,
        usedPercent: 30,
        resetsAt: NOW + 7_200,
      }),
      snapshot({
        providerId: "claude",
        capturedAt: NOW + 60,
        usedPercent: 40,
        resetsAt: NOW + 7_200,
      }),
    ],
    NOW + 60,
  );
  assert.deepEqual(
    (await store.readCurrent(NOW + 60)).map((segment) => ({
      providerId: segment.providerId,
      resetsAt: segment.resetsAt,
    })),
    [
      { providerId: "claude", resetsAt: NOW + 7_200 },
      { providerId: "codex", resetsAt: NOW + 7_200 },
    ],
  );

  await store.append(
    [
      snapshot({
        capturedAt: NOW + 7_200,
        usedPercent: 99,
        resetsAt: NOW + 7_200,
      }),
      snapshot({
        capturedAt: NOW + 7_200,
        usedPercent: 5,
        resetsAt: NOW + 10_800,
      }),
    ],
    NOW + 7_200,
  );
  const current = await store.readCurrent(NOW + 7_200);
  assert.equal(current.length, 1);
  assert.equal(current[0]?.resetsAt, NOW + 10_800);
  assert.deepEqual(current[0]?.samples, [
    {
      capturedAt: NOW + 7_200,
      observedAt: NOW + 7_200,
      usedPercent: 5,
    },
  ]);
});

test("persists closed segments for retention while readCurrent exposes only open cycles", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-history-closed-"),
  );
  const historyPath = path.join(directory, QUOTA_HISTORY_FILE);
  try {
    const store = new FileQuotaHistoryStore(historyPath);
    await store.append([snapshot({ resetsAt: NOW + 60 })], NOW);
    await store.append(
      [
        snapshot({
          capturedAt: NOW + 61,
          usedPercent: 5,
          resetsAt: NOW + 3_600,
        }),
      ],
      NOW + 61,
    );
    const current = await store.readCurrent(NOW + 61);
    assert.deepEqual(
      current.map((segment) => segment.resetsAt),
      [NOW + 3_600],
    );
    const persisted = parseQuotaHistoryDocument(
      JSON.parse(await fs.promises.readFile(historyPath, "utf8")),
      NOW + 61,
    );
    assert.deepEqual(
      persisted?.segments.map((segment) => segment.resetsAt),
      [NOW + 60, NOW + 3_600],
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("enforces the sample cap across reset segments in one series", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-history-series-cap-"),
  );
  const historyPath = path.join(directory, QUOTA_HISTORY_FILE);
  try {
    const store = new FileQuotaHistoryStore(historyPath);
    await store.append(
      Array.from(
        { length: QUOTA_HISTORY_MAX_SAMPLES_PER_SERIES + 5 },
        (_, index) =>
        snapshot({
          capturedAt: NOW + index,
          usedPercent: index % 100,
          resetsAt:
            NOW + 10_000 + Math.floor(index / 512) * 10_000,
        }),
      ),
      NOW + QUOTA_HISTORY_MAX_SAMPLES_PER_SERIES + 5,
    );
    const persisted = parseQuotaHistoryDocument(
      JSON.parse(await fs.promises.readFile(historyPath, "utf8")),
      NOW + QUOTA_HISTORY_MAX_SAMPLES_PER_SERIES + 5,
    );
    assert.equal(
      persisted?.segments.reduce(
        (count, segment) => count + segment.samples.length,
        0,
      ),
      QUOTA_HISTORY_MAX_SAMPLES_PER_SERIES,
    );
    assert.equal(persisted?.segments[0]?.samples[0]?.capturedAt, NOW + 5);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("retains fourteen days of five-hour and weekly cycles for every provider", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-history-retention-series-"),
  );
  const historyPath = path.join(directory, QUOTA_HISTORY_FILE);
  const fiveHours = QUOTA_WINDOW_MINUTES.fiveHours * 60;
  const week = QUOTA_WINDOW_MINUTES.weekly * 60;
  const observationCount =
    Math.floor(QUOTA_HISTORY_MAX_SAMPLE_AGE_SECONDS / fiveHours) + 1;
  try {
    const store = new FileQuotaHistoryStore(historyPath);
    for (let index = 0; index < observationCount; index += 1) {
      const observedAt = NOW + index * fiveHours;
      const elapsed = observedAt - NOW;
      const weeklyReset = NOW + (Math.floor(elapsed / week) + 1) * week;
      const windows = [
        {
          label: "Five hour",
          usedPercent: index % 101,
          windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
          resetsAt: observedAt + fiveHours,
        },
        {
          label: "Weekly",
          usedPercent: index % 101,
          windowMinutes: QUOTA_WINDOW_MINUTES.weekly,
          resetsAt: weeklyReset,
        },
      ];
      await store.append(
        (["codex", "claude"] as const).map((providerId) => ({
          providerId,
          connectionState: "connected",
          capturedAt: observedAt,
          windows,
        })),
        observedAt,
      );
    }

    const finalNow = NOW + (observationCount - 1) * fiveHours;
    const persisted = parseQuotaHistoryDocument(
      JSON.parse(await fs.promises.readFile(historyPath, "utf8")),
      finalNow,
    );
    assert.ok(persisted);
    for (const providerId of ["codex", "claude"] as const) {
      assert.equal(
        persisted.segments.filter(
          (segment) =>
            segment.providerId === providerId &&
            segment.windowMinutes === QUOTA_WINDOW_MINUTES.fiveHours,
        ).length,
        observationCount,
      );
      assert.equal(
        persisted.segments.filter(
          (segment) =>
            segment.providerId === providerId &&
            segment.windowMinutes === QUOTA_WINDOW_MINUTES.weekly,
        ).length,
        2,
      );
    }
    assert.equal(
      persisted.segments.reduce(
        (count, segment) => count + segment.samples.length,
        0,
      ),
      observationCount * 4,
    );
    assert.equal((await store.readCurrent(finalNow)).length, 4);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("drops samples outside the fourteen-day retention window", async () => {
  const store = new MemoryQuotaHistoryStore();
  const resetsAt = NOW + 30 * 86_400;
  await store.append([snapshot({ resetsAt })], NOW);
  const later = NOW + QUOTA_HISTORY_MAX_SAMPLE_AGE_SECONDS + 1;
  await store.append(
    [snapshot({ capturedAt: NOW, usedPercent: 30, resetsAt })],
    later,
  );
  assert.deepEqual((await store.readCurrent(later))[0]?.samples, [
    { capturedAt: NOW, observedAt: later, usedPercent: 30 },
  ]);
});

test("rejects future, post-reset, and regressing source observations", async () => {
  for (const invalid of [
    snapshot({ capturedAt: NOW + 1 }),
    snapshot({ capturedAt: NOW + 60, resetsAt: NOW + 60 }),
  ]) {
    const store = new MemoryQuotaHistoryStore();
    await assert.rejects(
      store.append([invalid], NOW),
      (error: unknown) =>
        error instanceof QuotaHistoryStoreError &&
        error.code === "invalid-observation",
    );
  }

  const store = new MemoryQuotaHistoryStore();
  await store.append([snapshot()], NOW);
  await assert.rejects(
    store.append([snapshot({ capturedAt: NOW - 1 })], NOW + 60),
    (error: unknown) =>
      error instanceof QuotaHistoryStoreError &&
      error.code === "invalid-observation",
  );
  assert.equal((await store.readCurrent(NOW + 60))[0]?.samples.length, 1);
});

test("corrupt or oversized history is replaced safely by the next valid append", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-history-corrupt-"),
  );
  try {
    for (const [index, contents] of [
      "{",
      JSON.stringify({ version: 2, segments: [] }),
      JSON.stringify({
        version: QUOTA_HISTORY_VERSION,
        segments: [
          {
            providerId: "codex",
            windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
            resetsAt: NOW + 3_600,
            samples: [
              {
                capturedAt: NOW + 1,
                observedAt: NOW,
                usedPercent: 20,
              },
            ],
          },
        ],
      }),
      "x".repeat(QUOTA_HISTORY_MAX_FILE_BYTES + 1),
    ].entries()) {
      const historyPath = path.join(
        directory,
        String(index),
        QUOTA_HISTORY_FILE,
      );
      await fs.promises.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.promises.writeFile(historyPath, contents, "utf8");
      const store = new FileQuotaHistoryStore(historyPath);
      assert.deepEqual(await store.readCurrent(NOW), []);
      await store.append([snapshot()], NOW);
      const parsed = parseQuotaHistoryDocument(
        JSON.parse(await fs.promises.readFile(historyPath, "utf8")),
      );
      assert.ok(parsed);
      assert.equal(parsed.segments.length, 1);
    }
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("trims oldest observations before an atomic write exceeds its byte cap", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-history-byte-cap-"),
  );
  const historyPath = path.join(directory, QUOTA_HISTORY_FILE);
  const maxFileBytes = 420;
  try {
    const store = new FileQuotaHistoryStore(historyPath, { maxFileBytes });
    for (let index = 0; index < 20; index += 1) {
      await store.append(
        [
          snapshot({
            capturedAt: NOW + index,
            usedPercent: index,
          }),
        ],
        NOW + index,
      );
    }
    const contents = await fs.promises.readFile(historyPath, "utf8");
    assert.ok(Buffer.byteLength(contents, "utf8") <= maxFileBytes);
    const persisted = parseQuotaHistoryDocument(
      JSON.parse(contents),
      NOW + 19,
    );
    assert.ok(persisted);
    assert.ok((persisted.segments[0]?.samples.length ?? 0) < 20);
    assert.equal(
      persisted.segments[0]?.samples.at(-1)?.observedAt,
      NOW + 19,
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("recovers from one valid backup and keeps at most one corrupt sibling", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-history-recovery-"),
  );
  const historyPath = path.join(directory, QUOTA_HISTORY_FILE);
  try {
    const store = new FileQuotaHistoryStore(historyPath);
    await store.append([snapshot()], NOW);
    await fs.promises.writeFile(historyPath, "{", "utf8");

    const quarantineTimestamp = 1_800_000_000_123;
    const recoveringStore = new FileQuotaHistoryStore(historyPath, {
      nowMilliseconds: () => quarantineTimestamp,
    });
    assert.equal((await recoveringStore.readCurrent(NOW)).length, 1);
    await recoveringStore.append([snapshot()], NOW);
    assert.ok(
      parseQuotaHistoryDocument(
        JSON.parse(await fs.promises.readFile(historyPath, "utf8")),
      ),
    );

    await fs.promises.writeFile(historyPath, "{", "utf8");
    await fs.promises.writeFile(
      path.join(directory, `${QUOTA_HISTORY_CORRUPT_PREFIX}1.json`),
      "old",
      "utf8",
    );
    await fs.promises.writeFile(
      path.join(directory, `${QUOTA_HISTORY_CORRUPT_PREFIX}2.json`),
      "old",
      "utf8",
    );
    assert.equal((await recoveringStore.readCurrent(NOW)).length, 1);
    assert.deepEqual(
      (await fs.promises.readdir(directory)).sort(),
      [
        QUOTA_HISTORY_BACKUP_FILE,
        `${QUOTA_HISTORY_CORRUPT_PREFIX}${quarantineTimestamp}.json`,
      ].sort(),
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("repairs a missing, stale, or corrupt backup across restart without failing reads", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-history-backup-repair-"),
  );
  const historyPath = path.join(directory, QUOTA_HISTORY_FILE);
  const backupPath = path.join(directory, QUOTA_HISTORY_BACKUP_FILE);
  let backupRenameFailuresRemaining = 2;
  try {
    const operations = fileOperations();
    const failingBackupOperations: NonNullable<
      FileQuotaHistoryStoreOptions["operations"]
    > = {
      ...operations,
      rename: async (source, destination) => {
        if (
          destination === backupPath &&
          backupRenameFailuresRemaining > 0
        ) {
          backupRenameFailuresRemaining -= 1;
          throw Object.assign(new Error("injected backup failure"), {
            code: "EACCES",
          });
        }
        await fs.promises.rename(source, destination);
      },
    };
    const originalStore = new FileQuotaHistoryStore(historyPath, {
      operations: failingBackupOperations,
      platform: "linux",
    });
    await originalStore.append([snapshot()], NOW);
    const primary = await fs.promises.readFile(historyPath, "utf8");
    await assert.rejects(fs.promises.readFile(backupPath, "utf8"), {
      code: "ENOENT",
    });

    const restartedStore = new FileQuotaHistoryStore(historyPath, {
      operations: failingBackupOperations,
      platform: "linux",
    });
    await restartedStore.append([snapshot()], NOW);
    await assert.rejects(fs.promises.readFile(backupPath, "utf8"), {
      code: "ENOENT",
    });
    assert.equal((await restartedStore.readCurrent(NOW)).length, 1);
    assert.equal(await fs.promises.readFile(backupPath, "utf8"), primary);

    const stale = `${JSON.stringify({
      version: QUOTA_HISTORY_VERSION,
      segments: [],
    })}\n`;
    await fs.promises.writeFile(backupPath, stale, "utf8");
    assert.equal((await restartedStore.readCurrent(NOW)).length, 1);
    assert.equal(await fs.promises.readFile(backupPath, "utf8"), primary);

    await fs.promises.writeFile(backupPath, "{", "utf8");
    assert.equal((await restartedStore.readCurrent(NOW)).length, 1);
    assert.equal(await fs.promises.readFile(backupPath, "utf8"), primary);
    assert.ok(
      parseQuotaHistoryDocument(
        JSON.parse(await fs.promises.readFile(backupPath, "utf8")),
        NOW,
      ),
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent file appends without losing samples", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-history-concurrent-"),
  );
  const historyPath = path.join(directory, QUOTA_HISTORY_FILE);
  try {
    const store = new FileQuotaHistoryStore(historyPath);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.append(
          [
            snapshot({
              capturedAt: NOW + index,
              usedPercent: index,
            }),
          ],
          NOW + index,
        ),
      ),
    );
    const current = await store.readCurrent(NOW + 19);
    assert.equal(current[0]?.samples.length, 20);
    assert.deepEqual(
      current[0]?.samples.map((sample) => sample.capturedAt),
      Array.from({ length: 20 }, (_, index) => NOW + index),
    );
    assert.deepEqual(
      (await fs.promises.readdir(directory)).sort(),
      [QUOTA_HISTORY_FILE, QUOTA_HISTORY_BACKUP_FILE].sort(),
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("retries transient Windows replacement and cleans temporary files", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-history-retry-"),
  );
  const historyPath = path.join(directory, QUOTA_HISTORY_FILE);
  const delays: number[] = [];
  let renameCalls = 0;
  try {
    const operations = fileOperations();
    const store = new FileQuotaHistoryStore(historyPath, {
      operations: {
        ...operations,
        rename: async (source, destination) => {
          renameCalls += 1;
          if (renameCalls <= 2) {
            throw Object.assign(new Error("injected transient failure"), {
              code: "EPERM",
            });
          }
          await fs.promises.rename(source, destination);
        },
      },
      platform: "win32",
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    await store.append([snapshot()], NOW);
    assert.equal(renameCalls, 4);
    assert.deepEqual(
      delays,
      QUOTA_HISTORY_RENAME_RETRY_DELAYS_MS.slice(0, 2),
    );
    assert.deepEqual(
      (await fs.promises.readdir(directory)).sort(),
      [QUOTA_HISTORY_FILE, QUOTA_HISTORY_BACKUP_FILE].sort(),
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("does not retry replacement outside the narrow Windows lock policy", async () => {
  for (const fixture of [
    { platform: "linux" as const, code: "EPERM" },
    { platform: "win32" as const, code: "EINVAL" },
  ]) {
    const directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "aum-history-no-retry-"),
    );
    const historyPath = path.join(directory, QUOTA_HISTORY_FILE);
    let renameCalls = 0;
    let delayCalls = 0;
    try {
      const operations = fileOperations();
      const store = new FileQuotaHistoryStore(historyPath, {
        operations: {
          ...operations,
          rename: async () => {
            renameCalls += 1;
            throw Object.assign(new Error("injected non-lock failure"), {
              code: fixture.code,
            });
          },
        },
        platform: fixture.platform,
        delay: async () => {
          delayCalls += 1;
        },
      });
      await assert.rejects(store.append([snapshot()], NOW));
      assert.equal(renameCalls, 1);
      assert.equal(delayCalls, 0);
      assert.deepEqual(await fs.promises.readdir(directory), []);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }
});

test("permanent atomic replacement failure preserves history and cleans its temp file", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-history-failure-"),
  );
  const historyPath = path.join(directory, QUOTA_HISTORY_FILE);
  try {
    const originalStore = new FileQuotaHistoryStore(historyPath);
    await originalStore.append([snapshot()], NOW);
    const original = await fs.promises.readFile(historyPath, "utf8");
    const operations = fileOperations();
    const failingStore = new FileQuotaHistoryStore(historyPath, {
      operations: {
        ...operations,
        rename: async () => {
          throw Object.assign(new Error("injected permanent failure"), {
            code: "EPERM",
          });
        },
      },
      platform: "win32",
      delay: async () => undefined,
      retryDelaysMs: [0],
    });
    await assert.rejects(
      failingStore.append(
        [snapshot({ capturedAt: NOW + 60, usedPercent: 30 })],
        NOW + 60,
      ),
      (error: unknown) =>
        error instanceof QuotaHistoryStoreError &&
        error.code === "write-failed",
    );
    assert.equal(await fs.promises.readFile(historyPath, "utf8"), original);
    assert.deepEqual(
      (await fs.promises.readdir(directory)).sort(),
      [QUOTA_HISTORY_FILE, QUOTA_HISTORY_BACKUP_FILE].sort(),
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("resolves the exact history path beneath LocalAppData", () => {
  assert.equal(
    resolveQuotaHistoryPath("C:\\isolated\\Local"),
    path.join(
      "C:\\isolated\\Local",
      QUOTA_HISTORY_DIRECTORY,
      QUOTA_HISTORY_FILE,
    ),
  );
});
