import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  QUOTA_WINDOW_MINUTES,
  type QuotaSnapshot,
  type QuotaWindowMinutes,
} from "../shared/contracts";
import { isStaleClaudeSnapshot } from "./monitor-state";

export const QUOTA_HISTORY_VERSION = 1;
export const QUOTA_HISTORY_FILE = "history-v1.json";
export const QUOTA_HISTORY_BACKUP_FILE = "history-v1.json.bak";
export const QUOTA_HISTORY_CORRUPT_PREFIX = "history-v1.corrupt.";
export const QUOTA_HISTORY_DIRECTORY = "AIUsageMonitor";
export const QUOTA_HISTORY_MAX_SAMPLES_PER_SERIES = 2_048;
export const QUOTA_HISTORY_MAX_TOTAL_SAMPLES = 8_192;
export const QUOTA_HISTORY_MAX_SAMPLE_AGE_SECONDS = 14 * 86_400;
export const QUOTA_HISTORY_MAX_FILE_BYTES = 2 * 1_024 * 1_024;
export const CODEX_UNCHANGED_CHECKPOINT_SECONDS = 15 * 60;
export const QUOTA_HISTORY_RENAME_RETRY_DELAYS_MS = [5, 15, 30, 60] as const;

export type QuotaHistoryProviderId = "codex" | "claude";

export type QuotaHistorySample = {
  capturedAt: number;
  observedAt: number;
  usedPercent: number;
};

export type QuotaHistorySegment = {
  providerId: QuotaHistoryProviderId;
  windowMinutes: QuotaWindowMinutes;
  resetsAt: number;
  samples: QuotaHistorySample[];
};

export type QuotaHistoryDocument = {
  version: typeof QUOTA_HISTORY_VERSION;
  segments: QuotaHistorySegment[];
};

export interface QuotaHistoryStore {
  append(snapshots: readonly QuotaSnapshot[], nowSeconds: number): Promise<void>;
  readCurrent(nowSeconds: number): Promise<QuotaHistorySegment[]>;
}

type HistoryFileOperations = {
  mkdir: typeof fs.promises.mkdir;
  open: typeof fs.promises.open;
  readFile: typeof fs.promises.readFile;
  readdir: typeof fs.promises.readdir;
  rename: typeof fs.promises.rename;
  rm: typeof fs.promises.rm;
};

type HistoryDocumentReadResult =
  | { kind: "missing" | "corrupt" }
  | {
      kind: "valid";
      document: QuotaHistoryDocument;
      serialized: string;
    };

export type FileQuotaHistoryStoreOptions = {
  operations?: HistoryFileOperations;
  platform?: NodeJS.Platform;
  delay?: (milliseconds: number) => Promise<void>;
  maxFileBytes?: number;
  nowMilliseconds?: () => number;
  retryDelaysMs?: readonly number[];
};

export type QuotaHistoryErrorCode =
  | "invalid-observation"
  | "read-failed"
  | "write-failed";

export class QuotaHistoryStoreError extends Error {
  readonly code: QuotaHistoryErrorCode;

  constructor(code: QuotaHistoryErrorCode) {
    super(`Quota history ${code}.`);
    this.name = "QuotaHistoryStoreError";
    this.code = code;
  }
}

const defaultOperations: HistoryFileOperations = {
  mkdir: fs.promises.mkdir.bind(fs.promises),
  open: fs.promises.open.bind(fs.promises),
  readFile: fs.promises.readFile.bind(fs.promises),
  readdir: fs.promises.readdir.bind(fs.promises),
  rename: fs.promises.rename.bind(fs.promises),
  rm: fs.promises.rm.bind(fs.promises),
};

export function resolveQuotaHistoryPath(localAppDataDirectory: string): string {
  return path.join(
    localAppDataDirectory,
    QUOTA_HISTORY_DIRECTORY,
    QUOTA_HISTORY_FILE,
  );
}

export function parseQuotaHistoryDocument(
  value: unknown,
  nowSeconds = Number.MAX_SAFE_INTEGER,
): QuotaHistoryDocument | null {
  if (!isUnixSeconds(nowSeconds)) {
    return null;
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== QUOTA_HISTORY_VERSION ||
    !Array.isArray(value.segments)
  ) {
    return null;
  }

  const segments: QuotaHistorySegment[] = [];
  let sampleCount = 0;
  const keys = new Set<string>();
  const seriesSampleCounts = new Map<string, number>();
  const latestSeriesCapturedAt = new Map<string, number>();
  let previousSegment: QuotaHistorySegment | undefined;
  for (const valueSegment of value.segments) {
    const segment = parseSegment(valueSegment, nowSeconds);
    if (!segment) {
      return null;
    }
    if (previousSegment && compareSegments(previousSegment, segment) > 0) {
      return null;
    }
    previousSegment = segment;
    const key = segmentKey(segment);
    if (keys.has(key)) {
      return null;
    }
    keys.add(key);
    sampleCount += segment.samples.length;
    if (sampleCount > QUOTA_HISTORY_MAX_TOTAL_SAMPLES) {
      return null;
    }
    const series = seriesKey(segment);
    const seriesCount =
      (seriesSampleCounts.get(series) ?? 0) + segment.samples.length;
    if (seriesCount > QUOTA_HISTORY_MAX_SAMPLES_PER_SERIES) {
      return null;
    }
    seriesSampleCounts.set(series, seriesCount);
    const previousCapturedAt = latestSeriesCapturedAt.get(series);
    const firstCapturedAt = segment.samples[0]?.capturedAt;
    const lastCapturedAt = segment.samples.at(-1)?.capturedAt;
    if (
      firstCapturedAt === undefined ||
      lastCapturedAt === undefined ||
      (previousCapturedAt !== undefined &&
        firstCapturedAt < previousCapturedAt)
    ) {
      return null;
    }
    latestSeriesCapturedAt.set(series, lastCapturedAt);
    segments.push(segment);
  }
  return { version: QUOTA_HISTORY_VERSION, segments };
}

export class FileQuotaHistoryStore implements QuotaHistoryStore {
  private operationTail: Promise<void> = Promise.resolve();
  private readonly operations: HistoryFileOperations;
  private readonly backupPath: string;
  private primaryNeedsRecovery = false;

  constructor(
    private readonly historyPath: string,
    private readonly options: FileQuotaHistoryStoreOptions = {},
  ) {
    this.operations = options.operations ?? defaultOperations;
    this.backupPath = path.join(
      path.dirname(historyPath),
      QUOTA_HISTORY_BACKUP_FILE,
    );
  }

  append(
    snapshots: readonly QuotaSnapshot[],
    nowSeconds: number,
  ): Promise<void> {
    return this.serialize(async () => {
      assertUnixSeconds(nowSeconds);
      const current = await this.readDocument(nowSeconds);
      const next = appendSnapshots(current, snapshots, nowSeconds);
      if (documentsEqual(current, next) && !this.primaryNeedsRecovery) {
        return;
      }
      await this.writeDocument(next);
    });
  }

  readCurrent(nowSeconds: number): Promise<QuotaHistorySegment[]> {
    return this.serialize(async () => {
      assertUnixSeconds(nowSeconds);
      const document = await this.readDocument(nowSeconds);
      return selectCurrentSegments(document.segments, nowSeconds);
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readDocument(nowSeconds: number): Promise<QuotaHistoryDocument> {
    const primary = await this.tryReadDocument(this.historyPath, nowSeconds);
    if (primary.kind === "valid") {
      this.primaryNeedsRecovery = false;
      await this.ensureBackupMatches(primary.serialized, nowSeconds);
      return primary.document;
    }
    if (primary.kind === "corrupt") {
      this.primaryNeedsRecovery = true;
      await this.quarantineCorruptPrimary();
    }
    const backup = await this.tryReadDocument(this.backupPath, nowSeconds);
    if (backup.kind === "valid") {
      this.primaryNeedsRecovery = true;
    }
    return backup.kind === "valid" ? backup.document : emptyDocument();
  }

  private async tryReadDocument(
    candidatePath: string,
    nowSeconds: number,
  ): Promise<HistoryDocumentReadResult> {
    let contents: string;
    try {
      contents = await this.operations.readFile(candidatePath, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return { kind: "missing" };
      }
      throw new QuotaHistoryStoreError("read-failed");
    }
    if (Buffer.byteLength(contents, "utf8") > this.maxFileBytes()) {
      return { kind: "corrupt" };
    }
    try {
      const document = parseQuotaHistoryDocument(
        JSON.parse(contents),
        nowSeconds,
      );
      return document
        ? { kind: "valid", document, serialized: contents }
        : { kind: "corrupt" };
    } catch {
      return { kind: "corrupt" };
    }
  }

  private async writeDocument(document: QuotaHistoryDocument): Promise<void> {
    const bounded = fitDocumentToFileCap(document, this.maxFileBytes());
    const serialized = `${JSON.stringify(bounded)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.maxFileBytes()) {
      throw new QuotaHistoryStoreError("write-failed");
    }
    await this.writeFileAtomically(this.historyPath, serialized);
    await this.repairBackup(serialized);
    this.primaryNeedsRecovery = false;
  }

  private async ensureBackupMatches(
    primarySerialized: string,
    nowSeconds: number,
  ): Promise<void> {
    let backup: HistoryDocumentReadResult;
    try {
      backup = await this.tryReadDocument(this.backupPath, nowSeconds);
    } catch {
      backup = { kind: "corrupt" };
    }
    if (
      backup.kind === "valid" &&
      backup.serialized === primarySerialized
    ) {
      return;
    }
    await this.repairBackup(primarySerialized);
  }

  private async repairBackup(serialized: string): Promise<void> {
    await this.writeFileAtomically(this.backupPath, serialized).catch(
      () => undefined,
    );
  }

  private async writeFileAtomically(
    destinationPath: string,
    serialized: string,
  ): Promise<void> {
    const directory = path.dirname(destinationPath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await this.operations.mkdir(directory, { recursive: true });
      const handle = await this.operations.open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(
        temporaryPath,
        destinationPath,
        this.operations.rename,
        this.options,
      );
    } catch (error) {
      await this.operations
        .rm(temporaryPath, { force: true })
        .catch(() => undefined);
      if (error instanceof QuotaHistoryStoreError) {
        throw error;
      }
      throw new QuotaHistoryStoreError("write-failed");
    }
  }

  private async quarantineCorruptPrimary(): Promise<void> {
    const directory = path.dirname(this.historyPath);
    const corruptName = `${QUOTA_HISTORY_CORRUPT_PREFIX}${this.nowMilliseconds()}.json`;
    const corruptPath = path.join(directory, corruptName);
    try {
      const entries = await this.operations.readdir(directory);
      await Promise.all(
        entries
          .filter(isCorruptHistorySibling)
          .map((entry) =>
            this.operations.rm(path.join(directory, entry), { force: true }),
        ),
      );
    } catch {
      // Do not create another sibling unless the previous one was removed.
      return;
    }
    await renameWithRetry(
      this.historyPath,
      corruptPath,
      this.operations.rename,
      this.options,
    ).catch(() => undefined);
  }

  private maxFileBytes(): number {
    return this.options.maxFileBytes ?? QUOTA_HISTORY_MAX_FILE_BYTES;
  }

  private nowMilliseconds(): number {
    return this.options.nowMilliseconds?.() ?? Date.now();
  }
}

export class MemoryQuotaHistoryStore implements QuotaHistoryStore {
  private document = emptyDocument();
  private operationTail: Promise<void> = Promise.resolve();

  append(
    snapshots: readonly QuotaSnapshot[],
    nowSeconds: number,
  ): Promise<void> {
    return this.serialize(async () => {
      assertUnixSeconds(nowSeconds);
      this.document = appendSnapshots(this.document, snapshots, nowSeconds);
    });
  }

  readCurrent(nowSeconds: number): Promise<QuotaHistorySegment[]> {
    return this.serialize(async () => {
      assertUnixSeconds(nowSeconds);
      if (!parseQuotaHistoryDocument(this.document, nowSeconds)) {
        throw new QuotaHistoryStoreError("read-failed");
      }
      return selectCurrentSegments(this.document.segments, nowSeconds);
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function appendSnapshots(
  document: QuotaHistoryDocument,
  snapshots: readonly QuotaSnapshot[],
  nowSeconds: number,
): QuotaHistoryDocument {
  const next = {
    version: QUOTA_HISTORY_VERSION,
    segments: cloneSegments(document.segments),
  } satisfies QuotaHistoryDocument;
  const minimumObservedAt = Math.max(
    0,
    nowSeconds - QUOTA_HISTORY_MAX_SAMPLE_AGE_SECONDS,
  );
  next.segments = next.segments
    .map((segment) => ({
      ...segment,
      samples: segment.samples.filter(
        (sample) => sample.observedAt >= minimumObservedAt,
      ),
    }))
    .filter((segment) => segment.samples.length > 0);

  for (const snapshot of snapshots) {
    const providerId = historyProviderId(snapshot.providerId);
    if (
      snapshot.connectionState !== "connected" ||
      !providerId ||
      isStaleClaudeSnapshot(snapshot, nowSeconds)
    ) {
      continue;
    }
    for (const window of snapshot.windows) {
      if (window.resetsAt <= nowSeconds) {
        continue;
      }
      assertValidObservation(snapshot, window.resetsAt, nowSeconds);
      const latestCapturedAt = getLatestSeriesCapturedAt(
        next.segments,
        providerId,
        window.windowMinutes,
      );
      if (
        latestCapturedAt !== undefined &&
        snapshot.capturedAt < latestCapturedAt
      ) {
        throw new QuotaHistoryStoreError("invalid-observation");
      }
      const key = segmentKey({
        providerId,
        windowMinutes: window.windowMinutes,
        resetsAt: window.resetsAt,
      });
      let segment = next.segments.find(
        (candidate) => segmentKey(candidate) === key,
      );
      if (!segment) {
        segment = {
          providerId,
          windowMinutes: window.windowMinutes,
          resetsAt: window.resetsAt,
          samples: [],
        };
        next.segments.push(segment);
      }
      const sample = {
        capturedAt: snapshot.capturedAt,
        observedAt: nowSeconds,
        usedPercent: window.usedPercent,
      };
      if (shouldAppendSample(segment, sample)) {
        segment.samples.push(sample);
      }
    }
  }

  next.segments.sort(compareSegments);
  trimSeriesSamples(next.segments);
  trimTotalSamples(next.segments);
  const bounded = fitDocumentToFileCap(next, QUOTA_HISTORY_MAX_FILE_BYTES);
  if (!parseQuotaHistoryDocument(bounded, nowSeconds)) {
    throw new QuotaHistoryStoreError("invalid-observation");
  }
  return bounded;
}

function shouldAppendSample(
  segment: QuotaHistorySegment,
  sample: QuotaHistorySample,
): boolean {
  if (
    segment.providerId === "claude" &&
    segment.samples.some(
      (candidate) =>
        candidate.capturedAt === sample.capturedAt &&
        candidate.usedPercent === sample.usedPercent,
    )
  ) {
    return false;
  }
  const latest = segment.samples.at(-1);
  return !(
    segment.providerId === "codex" &&
    latest &&
    latest.usedPercent === sample.usedPercent &&
    sample.observedAt >= latest.observedAt &&
    sample.observedAt - latest.observedAt <
      CODEX_UNCHANGED_CHECKPOINT_SECONDS
  );
}

function fitDocumentToFileCap(
  document: QuotaHistoryDocument,
  maxFileBytes: number,
): QuotaHistoryDocument {
  const bounded = {
    version: QUOTA_HISTORY_VERSION,
    segments: cloneSegments(document.segments),
  } satisfies QuotaHistoryDocument;
  while (
    Buffer.byteLength(JSON.stringify(bounded), "utf8") + 1 >
    maxFileBytes
  ) {
    let oldestSegment: QuotaHistorySegment | undefined;
    for (const segment of bounded.segments) {
      if (
        segment.samples.length > 0 &&
        (!oldestSegment ||
          (segment.samples[0]?.observedAt ?? Number.POSITIVE_INFINITY) <
            (oldestSegment.samples[0]?.observedAt ??
              Number.POSITIVE_INFINITY))
      ) {
        oldestSegment = segment;
      }
    }
    if (!oldestSegment) {
      break;
    }
    oldestSegment.samples.shift();
    if (oldestSegment.samples.length === 0) {
      bounded.segments.splice(bounded.segments.indexOf(oldestSegment), 1);
    }
  }
  return bounded;
}

function trimSeriesSamples(segments: QuotaHistorySegment[]): void {
  const series = new Map<string, QuotaHistorySegment[]>();
  for (const segment of segments) {
    const key = seriesKey(segment);
    const grouped = series.get(key) ?? [];
    grouped.push(segment);
    series.set(key, grouped);
  }
  for (const grouped of series.values()) {
    let count = grouped.reduce(
      (total, segment) => total + segment.samples.length,
      0,
    );
    while (count > QUOTA_HISTORY_MAX_SAMPLES_PER_SERIES) {
      const oldest = findOldestSampleSegment(grouped);
      if (!oldest) {
        break;
      }
      oldest.samples.shift();
      count -= 1;
    }
  }
  removeEmptySegments(segments);
}

function trimTotalSamples(segments: QuotaHistorySegment[]): void {
  let total = segments.reduce(
    (count, segment) => count + segment.samples.length,
    0,
  );
  while (total > QUOTA_HISTORY_MAX_TOTAL_SAMPLES) {
    const oldestSegment = findOldestSampleSegment(segments);
    if (!oldestSegment) {
      return;
    }
    oldestSegment.samples.shift();
    total -= 1;
  }
  removeEmptySegments(segments);
}

function findOldestSampleSegment(
  segments: readonly QuotaHistorySegment[],
): QuotaHistorySegment | undefined {
  let oldestSegment: QuotaHistorySegment | undefined;
  for (const segment of segments) {
    if (
      segment.samples.length > 0 &&
      (!oldestSegment ||
        (segment.samples[0]?.observedAt ?? Number.POSITIVE_INFINITY) <
          (oldestSegment.samples[0]?.observedAt ?? Number.POSITIVE_INFINITY))
    ) {
      oldestSegment = segment;
    }
  }
  return oldestSegment;
}

function removeEmptySegments(segments: QuotaHistorySegment[]): void {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index]?.samples.length === 0) {
      segments.splice(index, 1);
    }
  }
}

async function renameWithRetry(
  temporaryPath: string,
  historyPath: string,
  rename: HistoryFileOperations["rename"],
  options: FileQuotaHistoryStoreOptions,
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const delay = options.delay ?? wait;
  const retryDelays =
    options.retryDelaysMs ?? QUOTA_HISTORY_RENAME_RETRY_DELAYS_MS;
  let retryIndex = 0;
  while (true) {
    try {
      await rename(temporaryPath, historyPath);
      return;
    } catch (error) {
      if (
        platform !== "win32" ||
        !isTransientWindowsRenameError(error) ||
        retryIndex >= retryDelays.length
      ) {
        throw error;
      }
      const milliseconds = retryDelays[retryIndex] ?? 0;
      retryIndex += 1;
      await delay(milliseconds);
    }
  }
}

function parseSegment(
  value: unknown,
  nowSeconds: number,
): QuotaHistorySegment | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    !isHistoryProviderId(value.providerId) ||
    !isWindowMinutes(value.windowMinutes) ||
    !isUnixSeconds(value.resetsAt) ||
    !Array.isArray(value.samples) ||
    value.samples.length === 0 ||
    value.samples.length > QUOTA_HISTORY_MAX_SAMPLES_PER_SERIES
  ) {
    return null;
  }
  const samples: QuotaHistorySample[] = [];
  const sampleKeys = new Set<string>();
  let previousCapturedAt = -1;
  let previousObservedAt = -1;
  for (const valueSample of value.samples) {
    const sample = parseSample(valueSample);
    if (
      !sample ||
      sample.capturedAt < previousCapturedAt ||
      sample.observedAt < previousObservedAt ||
      sample.capturedAt > sample.observedAt ||
      sample.observedAt > nowSeconds ||
      sample.capturedAt >= value.resetsAt ||
      sample.observedAt >= value.resetsAt
    ) {
      return null;
    }
    const sampleKey = `${sample.capturedAt}:${sample.observedAt}:${sample.usedPercent}`;
    if (sampleKeys.has(sampleKey)) {
      return null;
    }
    sampleKeys.add(sampleKey);
    previousCapturedAt = sample.capturedAt;
    previousObservedAt = sample.observedAt;
    samples.push(sample);
  }
  return {
    providerId: value.providerId,
    windowMinutes: value.windowMinutes,
    resetsAt: value.resetsAt,
    samples,
  };
}

function parseSample(value: unknown): QuotaHistorySample | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    !isUnixSeconds(value.capturedAt) ||
    !isUnixSeconds(value.observedAt) ||
    !isPercentage(value.usedPercent)
  ) {
    return null;
  }
  return {
    capturedAt: value.capturedAt,
    observedAt: value.observedAt,
    usedPercent: value.usedPercent,
  };
}

function compareSegments(
  left: QuotaHistorySegment,
  right: QuotaHistorySegment,
): number {
  return (
    left.resetsAt - right.resetsAt ||
    left.providerId.localeCompare(right.providerId) ||
    left.windowMinutes - right.windowMinutes
  );
}

function selectCurrentSegments(
  segments: readonly QuotaHistorySegment[],
  nowSeconds: number,
): QuotaHistorySegment[] {
  const latestBySeries = new Map<string, QuotaHistorySegment>();
  for (const segment of segments) {
    if (segment.resetsAt <= nowSeconds) {
      continue;
    }
    const key = seriesKey(segment);
    const latest = latestBySeries.get(key);
    if (!latest || segment.resetsAt > latest.resetsAt) {
      latestBySeries.set(key, segment);
    }
  }
  return cloneSegments([...latestBySeries.values()].sort(compareSegments));
}

function seriesKey(
  segment: Pick<QuotaHistorySegment, "providerId" | "windowMinutes">,
): string {
  return `${segment.providerId}:${segment.windowMinutes}`;
}

function segmentKey(
  segment: Pick<
    QuotaHistorySegment,
    "providerId" | "windowMinutes" | "resetsAt"
  >,
): string {
  return `${segment.providerId}:${segment.windowMinutes}:${segment.resetsAt}`;
}

function getLatestSeriesCapturedAt(
  segments: readonly QuotaHistorySegment[],
  providerId: QuotaHistoryProviderId,
  windowMinutes: QuotaWindowMinutes,
): number | undefined {
  let latest: number | undefined;
  for (const segment of segments) {
    if (
      segment.providerId !== providerId ||
      segment.windowMinutes !== windowMinutes
    ) {
      continue;
    }
    const capturedAt = segment.samples.at(-1)?.capturedAt;
    if (capturedAt !== undefined) {
      latest = latest === undefined ? capturedAt : Math.max(latest, capturedAt);
    }
  }
  return latest;
}

function assertValidObservation(
  snapshot: QuotaSnapshot,
  resetsAt: number,
  observedAt: number,
): void {
  if (
    !isUnixSeconds(snapshot.capturedAt) ||
    snapshot.capturedAt > observedAt ||
    snapshot.capturedAt >= resetsAt
  ) {
    throw new QuotaHistoryStoreError("invalid-observation");
  }
}

function assertUnixSeconds(value: number): void {
  if (!isUnixSeconds(value)) {
    throw new QuotaHistoryStoreError("invalid-observation");
  }
}

function documentsEqual(
  left: QuotaHistoryDocument,
  right: QuotaHistoryDocument,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function emptyDocument(): QuotaHistoryDocument {
  return { version: QUOTA_HISTORY_VERSION, segments: [] };
}

function cloneSegments(
  segments: readonly QuotaHistorySegment[],
): QuotaHistorySegment[] {
  return segments.map((segment) => ({
    ...segment,
    samples: segment.samples.map((sample) => ({ ...sample })),
  }));
}

function historyProviderId(
  providerId: string,
): QuotaHistoryProviderId | null {
  return isHistoryProviderId(providerId) ? providerId : null;
}

function isHistoryProviderId(
  value: unknown,
): value is QuotaHistoryProviderId {
  return value === "codex" || value === "claude";
}

function isWindowMinutes(value: unknown): value is QuotaWindowMinutes {
  return (
    value === QUOTA_WINDOW_MINUTES.fiveHours ||
    value === QUOTA_WINDOW_MINUTES.weekly
  );
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

function isTransientWindowsRenameError(error: unknown): boolean {
  return (
    hasErrorCode(error, "EPERM") ||
    hasErrorCode(error, "EBUSY") ||
    hasErrorCode(error, "EACCES")
  );
}

function isCorruptHistorySibling(entry: string): boolean {
  return (
    entry.startsWith(QUOTA_HISTORY_CORRUPT_PREFIX) &&
    entry.endsWith(".json") &&
    entry.length > QUOTA_HISTORY_CORRUPT_PREFIX.length + ".json".length
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
