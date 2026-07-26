import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  screen,
  Tray,
  type IpcMainInvokeEvent,
  type NativeImage,
  type Rectangle,
} from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  IPC_CHANNELS,
  isForceRefreshRequest,
  isInstallClaudeHookRequest,
  isQuotaSnapshot,
  isQuitRequestArguments,
  type QuotaSnapshot,
  type ClaudeSetupState,
} from "../shared/contracts";
import { positionPopup } from "./position";
import {
  didProviderRefreshFail,
  POLL_INTERVAL_MS,
  QuotaMonitorPolicy,
  type MonitorNotification,
  type ThresholdNotification,
  type TraySeverity,
} from "./monitor-state";
import { BackgroundTaskScheduler } from "./background-task";
import { retainNotification } from "./notification-lifetime";
import { ClaudeQuotaProvider } from "./providers/claude";
import { CodexQuotaProvider } from "./providers/codex";
import {
  inspectClaudeSetup,
  installClaudeHook,
  resolveDeployedStatusLinePath,
  type ClaudeHookPaths,
} from "./providers/claude-onboarding";

const POPUP_SIZE = { width: 340, height: 420 };
const SELF_TEST = process.argv.includes("--self-test");
const MANUAL_HARNESS = process.argv.includes("--manual-harness");
const LOG_PATH = process.env.AUM_SPIKE_LOG;

type RuntimeState = {
  backgroundTicks: number;
  broadcasts: number;
  refreshes: number;
  rendererQuitRequests: number;
  providerReads: number;
  notifications: number;
  pollRefreshes: number;
  resumeRefreshes: number;
  trayRecreations: number;
  claudeHookInstalls: number;
};

const state: RuntimeState = {
  backgroundTicks: 0,
  broadcasts: 0,
  refreshes: 0,
  rendererQuitRequests: 0,
  providerReads: 0,
  notifications: 0,
  pollRefreshes: 0,
  resumeRefreshes: 0,
  trayRecreations: 0,
  claudeHookInstalls: 0,
};

let popup: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let currentTraySeverity: TraySeverity = "warning";
let refreshInFlight: Promise<QuotaSnapshot[]> | null = null;
let pollTimer: NodeJS.Timeout | undefined;
let trayWatchdogTimer: NodeJS.Timeout | undefined;
let selfTestHeartbeatTimer: NodeJS.Timeout | undefined;
let selfTestOnboardingRoot: string | undefined;
const monitorPolicy = new QuotaMonitorPolicy();
const selfTestNotificationActivations: Array<() => void> = [];
const activeNotifications = new Set<Notification>();
const backgroundTasks = new BackgroundTaskScheduler((error) => {
  safeLog("background-task-failed", {
    message: error instanceof Error ? error.message : "Unknown error",
  });
});
const codexProvider = SELF_TEST
  ? {
      readQuota: async (): Promise<QuotaSnapshot> => ({
        providerId: "codex",
        connectionState: "error",
        windows: [],
        capturedAt: Math.floor(Date.now() / 1_000),
        error: "Codex self-test refresh failed.",
      }),
      dispose: () => undefined,
    }
  : new CodexQuotaProvider();
const claudeProvider = SELF_TEST
  ? {
      readQuota: async (): Promise<QuotaSnapshot> => ({
        providerId: "claude",
        connectionState: "no-data-yet",
        windows: [],
        capturedAt: Math.floor(Date.now() / 1_000),
        error: "Claude provider has no self-test fixture.",
      }),
    }
  : new ClaudeQuotaProvider();

type ProviderReader = {
  providerId: "codex" | "claude";
  readQuota: () => Promise<QuotaSnapshot>;
};

type RefreshReason = "startup" | "poll" | "user" | "tray-menu" | "resume";

const providerReaders: ProviderReader[] = [
  { providerId: "codex", readQuota: () => codexProvider.readQuota() },
  { providerId: "claude", readQuota: () => claudeProvider.readQuota() },
];

function cleanupSelfTestOnboarding(): void {
  if (!selfTestOnboardingRoot) {
    return;
  }
  fs.rmSync(selfTestOnboardingRoot, { recursive: true, force: true });
  selfTestOnboardingRoot = undefined;
}

let cachedSnapshots = createInitialSnapshots();

const rendererPath = path.join(__dirname, "..", "renderer", "index.html");
const rendererUrl = pathToFileURL(rendererPath).toString();
const trayRepresentations = [
  { size: 16, scaleFactor: 1 },
  { size: 20, scaleFactor: 1.25 },
  { size: 24, scaleFactor: 1.5 },
  { size: 32, scaleFactor: 2 },
  { size: 48, scaleFactor: 3 },
] as const;

let trayIconMetadata:
  | {
      assetDirectory: string;
      scaleFactors: number[];
    }
  | undefined;
const trayImageCache = new Map<TraySeverity, NativeImage>();

function log(event: string, details: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...details,
  });
  process.stdout.write(`${entry}\n`);
  if (LOG_PATH) {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${entry}\n`, "utf8");
  }
}

function safeLog(event: string, details: Record<string, unknown> = {}): void {
  try {
    log(event, details);
  } catch {
    // Diagnostics must not turn a background failure into an unhandled error.
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function createInitialSnapshots(): QuotaSnapshot[] {
  const capturedAt = nowSeconds();
  return [
    {
      providerId: "codex",
      connectionState: SELF_TEST ? "not-connected" : "no-data-yet",
      windows: [],
      capturedAt,
      ...(SELF_TEST
        ? { error: "Codex provider is disabled during the Electron self-test." }
        : {}),
    },
    {
      providerId: "claude",
      connectionState: "no-data-yet",
      windows: [],
      capturedAt,
    },
  ];
}

function createProviderErrorSnapshot(
  providerId: string,
): QuotaSnapshot {
  return {
    providerId,
    connectionState: "error",
    windows: [],
    capturedAt: nowSeconds(),
    error: `${providerId === "codex" ? "Codex" : "Claude Code"} refresh failed.`,
  };
}

async function readProviderSafely(
  reader: ProviderReader,
): Promise<QuotaSnapshot> {
  state.providerReads += 1;
  try {
    const snapshot = await reader.readQuota();
    if (
      !isQuotaSnapshot(snapshot) ||
      snapshot.providerId !== reader.providerId
    ) {
      throw new Error("Provider returned an invalid quota snapshot");
    }
    return snapshot;
  } catch {
    log("provider-refresh-failed", { providerId: reader.providerId });
    return createProviderErrorSnapshot(reader.providerId);
  }
}

async function refreshProviderSnapshots(): Promise<{
  snapshots: QuotaSnapshot[];
  refreshFailed: boolean;
}> {
  const snapshots = await Promise.all(providerReaders.map(readProviderSafely));
  return {
    snapshots,
    refreshFailed: didProviderRefreshFail(snapshots),
  };
}

function broadcastCachedSnapshots(): void {
  if (
    popup &&
    !popup.isDestroyed() &&
    !popup.webContents.isLoading()
  ) {
    try {
      popup.webContents.send(IPC_CHANNELS.quotaUpdated, cachedSnapshots);
      state.broadcasts += 1;
    } catch (error) {
      log("renderer-broadcast-failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}

async function refreshMonitor(reason: RefreshReason): Promise<QuotaSnapshot[]> {
  if (refreshInFlight) {
    log("refresh-coalesced", { reason });
    return refreshInFlight;
  }

  const operation = (async () => {
    state.refreshes += 1;
    if (reason === "poll") {
      state.pollRefreshes += 1;
    } else if (reason === "resume") {
      state.resumeRefreshes += 1;
    }
    log("refresh", { refreshes: state.refreshes, reason });

    const result = await refreshProviderSnapshots();
    cachedSnapshots = result.snapshots;
    const decision = monitorPolicy.evaluate({
      snapshots: cachedSnapshots,
      refreshFailed: result.refreshFailed,
      nowSeconds: nowSeconds(),
    });
    updateTraySeverity(decision.traySeverity);
    broadcastCachedSnapshots();
    for (const notification of decision.notifications) {
      deliverNotification(notification);
    }
    return cachedSnapshots;
  })();
  refreshInFlight = operation;
  try {
    return await operation;
  } finally {
    if (refreshInFlight === operation) {
      refreshInFlight = null;
    }
  }
}

function scheduleRefresh(reason: RefreshReason): Promise<void> {
  return backgroundTasks.run(() => refreshMonitor(reason));
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (
    !popup ||
    popup.isDestroyed() ||
    event.sender !== popup.webContents ||
    event.senderFrame !== popup.webContents.mainFrame ||
    event.senderFrame.url !== rendererUrl
  ) {
    throw new Error("Rejected IPC request from an untrusted sender");
  }
}

async function readQuota(
  event: IpcMainInvokeEvent,
): Promise<QuotaSnapshot[]> {
  assertTrustedSender(event);
  return cachedSnapshots;
}

async function forceRefresh(
  event: IpcMainInvokeEvent,
  payload: unknown,
): Promise<QuotaSnapshot[]> {
  assertTrustedSender(event);
  if (!isForceRefreshRequest(payload)) {
    throw new TypeError("Invalid forced-refresh request");
  }

  return refreshMonitor(payload.reason);
}

function getClaudeHookPaths(): ClaudeHookPaths {
  if (SELF_TEST) {
    if (!selfTestOnboardingRoot) {
      throw new Error("Claude self-test onboarding paths are unavailable");
    }
    const sourceBase = app.isPackaged
      ? process.resourcesPath
      : app.getAppPath();
    const destinationBase = path.join(selfTestOnboardingRoot, "local");
    return {
      settingsPath: path.join(
        selfTestOnboardingRoot,
        ".claude",
        "settings.json",
      ),
      sourceBase,
      sourceRoot: path.join(sourceBase, "dist-tools"),
      destinationBase,
      destinationRoot: path.join(
        destinationBase,
        "AIUsageMonitor",
        "claude-hook",
        "v1",
      ),
    };
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !path.isAbsolute(localAppData)) {
    throw new Error("Local AppData is unavailable");
  }
  const sourceBase = app.isPackaged
    ? process.resourcesPath
    : app.getAppPath();
  return {
    settingsPath: path.join(app.getPath("home"), ".claude", "settings.json"),
    sourceBase,
    sourceRoot: path.join(sourceBase, "dist-tools"),
    destinationBase: localAppData,
    destinationRoot: path.join(
      localAppData,
      "AIUsageMonitor",
      "claude-hook",
      "v1",
    ),
  };
}

function claudeCacheIsAvailable(): boolean {
  return cachedSnapshots.some(
    (snapshot) =>
      snapshot.providerId === "claude" &&
      snapshot.connectionState === "connected",
  );
}

async function readClaudeSetup(
  event: IpcMainInvokeEvent,
  ...payload: unknown[]
): Promise<ClaudeSetupState> {
  assertTrustedSender(event);
  if (!isQuitRequestArguments(payload)) {
    throw new TypeError("Invalid Claude setup read request");
  }
  try {
    const paths = getClaudeHookPaths();
    return await inspectClaudeSetup({
      settingsPath: paths.settingsPath,
      deployedStatusLinePath: resolveDeployedStatusLinePath(
        paths.destinationRoot,
      ),
      cacheAvailable: claudeCacheIsAvailable(),
    });
  } catch {
    return {
      status: "error",
      message: "Claude setup could not be checked. Try again.",
    };
  }
}

async function installClaudeHookFromRenderer(
  event: IpcMainInvokeEvent,
  payload: unknown,
): Promise<ClaudeSetupState> {
  assertTrustedSender(event);
  if (!isInstallClaudeHookRequest(payload)) {
    throw new TypeError("Invalid Claude hook install request");
  }
  state.claudeHookInstalls += 1;
  try {
    return await installClaudeHook({ paths: getClaudeHookPaths() });
  } catch {
    return {
      status: "error",
      message: "Claude setup could not be installed. Try again.",
    };
  }
}

async function quitFromRenderer(
  event: IpcMainInvokeEvent,
  ...payload: unknown[]
): Promise<void> {
  assertTrustedSender(event);
  if (!isQuitRequestArguments(payload)) {
    throw new TypeError("Invalid quit request");
  }

  state.rendererQuitRequests += 1;
  log("quit-from-renderer", {
    requests: state.rendererQuitRequests,
  });
  if (!SELF_TEST) {
    quitting = true;
    setImmediate(() => app.quit());
  }
}

function hidePopup(reason: string): void {
  if (!popup?.isVisible()) {
    return;
  }
  popup.hide();
  log("popup-hidden", { reason });
}

function placePopup(trayBounds: Rectangle): Rectangle {
  const center = {
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2),
  };
  const display = screen.getDisplayNearestPoint(center);
  const bounds = positionPopup(trayBounds, display.workArea, POPUP_SIZE);
  popup?.setBounds(bounds, false);
  log("popup-positioned", {
    trayBounds,
    popupBounds: bounds,
    displayId: display.id,
    displayScaleFactor: display.scaleFactor,
    displayWorkArea: display.workArea,
  });
  return bounds;
}

function showPopup(trayBounds: Rectangle, reason: string): void {
  if (!popup) {
    return;
  }
  broadcastCachedSnapshots();
  placePopup(trayBounds);
  popup.show();
  log("popup-shown-focused", {
    reason,
    focused: popup.isFocused(),
    visible: popup.isVisible(),
  });
}

function togglePopup(trayBounds: Rectangle): void {
  if (popup?.isVisible()) {
    hidePopup("tray-toggle");
  } else {
    showPopup(trayBounds, "tray-toggle");
  }
}

function createTrayImage(severity: TraySeverity): NativeImage {
  const cached = trayImageCache.get(severity);
  if (cached) {
    return cached;
  }
  const assetDirectory = path.join(app.getAppPath(), "assets", "icons");
  let image: NativeImage | undefined;

  for (const representation of trayRepresentations) {
    const assetPath = path.join(
      assetDirectory,
      `tray-${severity}-${representation.size}.png`,
    );
    const buffer = fs.readFileSync(assetPath);
    const decoded = nativeImage.createFromBuffer(buffer);
    const decodedSize = decoded.getSize();
    if (
      decoded.isEmpty() ||
      decodedSize.width !== representation.size ||
      decodedSize.height !== representation.size
    ) {
      throw new Error(`Tray icon asset failed to decode: ${assetPath}`);
    }

    if (!image) {
      image = nativeImage.createFromBuffer(buffer, {
        scaleFactor: representation.scaleFactor,
      });
    } else {
      image.addRepresentation({
        scaleFactor: representation.scaleFactor,
        buffer,
      });
    }
  }

  if (!image || image.isEmpty()) {
    throw new Error("Tray icon has no usable raster representations");
  }

  trayIconMetadata = {
    assetDirectory,
    scaleFactors: image.getScaleFactors(),
  };
  trayImageCache.set(severity, image);
  log("tray-icon-loaded", { ...trayIconMetadata, severity });
  return image;
}

function updateTraySeverity(severity: TraySeverity): void {
  currentTraySeverity = severity;
  if (!tray || tray.isDestroyed()) {
    return;
  }
  tray.setImage(createTrayImage(severity));
  tray.setToolTip(`AI Usage Monitor — ${severity}`);
  log("tray-state-updated", { severity });
}

function createPopup(): BrowserWindow {
  const window = new BrowserWindow({
    ...POPUP_SIZE,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#111827",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.setMenu(null);
  window.on("blur", () => {
    log("popup-blur", { visible: window.isVisible() });
    hidePopup("blur");
  });
  window.on("focus", () => log("popup-focus"));
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      hidePopup("close-request");
    }
  });
  window.webContents.on("did-finish-load", () => log("renderer-ready"));
  void window.loadFile(rendererPath);
  return window;
}

function requestRefreshFromTray(): void {
  void scheduleRefresh("tray-menu");
}

function createTray(reason: string): Tray {
  const appTray = new Tray(createTrayImage(currentTraySeverity));
  appTray.setToolTip(`AI Usage Monitor — ${currentTraySeverity}`);
  appTray.on("click", (_event, bounds) => togglePopup(bounds));
  appTray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Refresh", click: requestRefreshFromTray },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          log("quit-from-tray");
          app.quit();
        },
      },
    ]),
  );
  log("tray-created", {
    trayBounds: appTray.getBounds(),
    reason,
    severity: currentTraySeverity,
  });
  return appTray;
}

function ensureTray(reason: string): Tray {
  let usable = false;
  if (tray && !tray.isDestroyed()) {
    try {
      const bounds = tray.getBounds();
      usable = bounds.width > 0 && bounds.height > 0;
    } catch {
      usable = false;
    }
  }
  if (usable && tray) {
    return tray;
  }

  if (tray && !tray.isDestroyed()) {
    tray.destroy();
  }
  tray = createTray(reason);
  state.trayRecreations += 1;
  log("tray-recreated", {
    reason,
    recreations: state.trayRecreations,
  });
  return tray;
}

function openPanelFromNotification(): void {
  const activeTray = ensureTray("notification");
  showPopup(activeTray.getBounds(), "notification");
}

function providerDisplayName(providerId: string): string {
  return providerId === "claude" ? "Claude Code" : "Codex";
}

function quotaWindowName(windowMinutes: number): string {
  return windowMinutes === 300 ? "5-hour" : "weekly";
}

function thresholdNotificationCopy(
  notification: ThresholdNotification,
): { title: string; body: string } {
  const provider = providerDisplayName(notification.providerId);
  const remaining = Math.max(0, Math.round(100 - notification.usedPercent));
  const level =
    notification.threshold === 100
      ? "limit reached"
      : notification.threshold === 90
        ? "quota critical"
        : "quota warning";
  return {
    title: `${provider} ${level}`,
    body: `${quotaWindowName(notification.windowMinutes)} usage is ${Math.round(notification.usedPercent)}% · ${remaining}% left.`,
  };
}

function deliverNotification(notification: MonitorNotification): void {
  const copy =
    notification.kind === "threshold"
      ? thresholdNotificationCopy(notification)
      : {
          title: "AI usage refresh failed",
          body: "Three consecutive refresh attempts failed. Open the panel for details.",
        };
  state.notifications += 1;
  log("notification-created", {
    kind: notification.kind,
    notifications: state.notifications,
  });

  if (SELF_TEST) {
    selfTestNotificationActivations.push(openPanelFromNotification);
    return;
  }
  if (!Notification.isSupported()) {
    log("notification-unsupported", { kind: notification.kind });
    return;
  }
  try {
    const nativeNotification = new Notification(copy);
    const lifetime = retainNotification(
      activeNotifications,
      nativeNotification,
      (error) => {
        safeLog("notification-failed", {
          kind: notification.kind,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    nativeNotification.on("click", () => {
      lifetime.release();
      openPanelFromNotification();
    });
    nativeNotification.on("close", lifetime.release);
    nativeNotification.on("failed", (_event, error) => {
      lifetime.fail(error);
    });
    try {
      nativeNotification.show();
    } catch (error) {
      lifetime.fail(error);
    }
  } catch (error) {
    safeLog("notification-failed", {
      kind: notification.kind,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function handleSystemResume(): Promise<void> {
  const activeAtResume = refreshInFlight;
  return backgroundTasks.runAfterSettled(activeAtResume, async () => {
    log("system-resume");
    ensureTray("system-resume");
    await refreshMonitor("resume");
  });
}

function startBackgroundMonitoring(): void {
  void scheduleRefresh("startup");
  pollTimer = setInterval(() => {
    void scheduleRefresh("poll");
  }, POLL_INTERVAL_MS);
  pollTimer.unref();

  trayWatchdogTimer = setInterval(() => {
    void backgroundTasks.run(() => ensureTray("explorer-watchdog"));
  }, 10_000);
  trayWatchdogTimer.unref();
}

async function waitForRenderer(): Promise<void> {
  if (!popup) {
    throw new Error("Popup was not initialized");
  }
  if (!popup.webContents.isLoading()) {
    return;
  }
  await new Promise<void>((resolve) => {
    popup?.webContents.once("did-finish-load", () => resolve());
  });
}

async function verifyRendererBoundary(): Promise<void> {
  if (!popup) {
    throw new Error("Popup was not initialized");
  }
  const boundary = (await popup.webContents.executeJavaScript(`({
    processType: typeof window.process,
    requireType: typeof window.require,
    apiKeys: Object.keys(window.aiUsageMonitor).sort(),
    apiFrozen: Object.isFrozen(window.aiUsageMonitor)
  })`)) as {
    processType: string;
    requireType: string;
    apiKeys: string[];
    apiFrozen: boolean;
  };

  const expectedKeys = [
    "forceRefresh",
    "installClaudeHook",
    "onQuotaUpdated",
    "quit",
    "readClaudeSetup",
    "readQuota",
  ];
  if (
    boundary.processType !== "undefined" ||
    boundary.requireType !== "undefined" ||
    JSON.stringify(boundary.apiKeys) !== JSON.stringify(expectedKeys) ||
    !boundary.apiFrozen
  ) {
    throw new Error(`Renderer boundary failed: ${JSON.stringify(boundary)}`);
  }
  log("self-test-security-pass", boundary);
}

async function verifyPanelRendering(): Promise<void> {
  if (!popup) {
    throw new Error("Popup was not initialized");
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const panel = (await popup.webContents.executeJavaScript(`(() => {
      const main = document.querySelector("main");
      const buttons = [...document.querySelectorAll("button")];
      const control = (label) => {
        const button = buttons.find(
          (candidate) => candidate.textContent?.trim() === label
        );
        const bounds = button?.getBoundingClientRect();
        return {
          present: Boolean(button),
          focusable:
            Boolean(button) &&
            !button.disabled &&
            button.tabIndex >= 0 &&
            Boolean(bounds && bounds.width > 0 && bounds.height > 0)
        };
      };
      return {
        text: main?.textContent ?? "",
        width: main?.getBoundingClientRect().width ?? 0,
        height: main?.getBoundingClientRect().height ?? 0,
        buttons: buttons.map((button) => button.textContent?.trim()),
        refresh: control("Refresh"),
        quit: control("Quit")
      };
    })()`)) as {
      text: string;
      width: number;
      height: number;
      buttons: Array<string | undefined>;
      refresh: { present: boolean; focusable: boolean };
      quit: { present: boolean; focusable: boolean };
    };
    const expectedCopy = [
      "AI QUOTA",
      "Codex isn’t connected",
      "Claude Code — Setup required",
    ];
    if (
      panel.width === POPUP_SIZE.width &&
      panel.height === POPUP_SIZE.height &&
      expectedCopy.every((copy) => panel.text.includes(copy)) &&
      !panel.text.includes("OpenCode") &&
      panel.buttons.includes("Refresh") &&
      panel.buttons.includes("Quit") &&
      panel.refresh.present &&
      panel.refresh.focusable &&
      panel.quit.present &&
      panel.quit.focusable
    ) {
      log("self-test-panel-pass", {
        width: panel.width,
        height: panel.height,
        controls: panel.buttons,
      });
      return;
    }
    await delay(25);
  }

  throw new Error("Renderer panel did not reach the expected self-test state");
}

async function waitForPanelCopy(expectedCopy: string): Promise<void> {
  if (!popup) {
    throw new Error("Popup was not initialized");
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const text = (await popup.webContents.executeJavaScript(
      'document.querySelector("main")?.textContent ?? ""',
    )) as string;
    if (text.includes(expectedCopy)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Renderer did not show expected copy: ${expectedCopy}`);
}

async function reloadSelfTestRenderer(): Promise<void> {
  if (!popup) {
    throw new Error("Popup was not initialized");
  }
  const loaded = new Promise<void>((resolve) => {
    popup?.webContents.once("did-finish-load", () => resolve());
  });
  popup.webContents.reload();
  await loaded;
}

async function verifyConnectedPanelRendering(): Promise<void> {
  if (!popup) {
    throw new Error("Popup was not initialized");
  }
  const capturedAt = nowSeconds();
  const connectedFixture: QuotaSnapshot[] = [
    {
      providerId: "codex",
      connectionState: "connected",
      capturedAt,
      windows: [
        {
          label: "Five hours",
          usedPercent: 42,
          windowMinutes: 300,
          resetsAt: capturedAt + 3_600,
        },
        {
          label: "Weekly",
          usedPercent: 91,
          windowMinutes: 10_080,
          resetsAt: capturedAt + 604_800,
        },
      ],
    },
    cachedSnapshots.find((snapshot) => snapshot.providerId === "claude") ??
      createProviderErrorSnapshot("claude"),
  ];
  popup.webContents.send(IPC_CHANNELS.quotaUpdated, connectedFixture);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const panel = (await popup.webContents.executeJavaScript(`(() => {
      const content = document.querySelector("[data-panel-content]");
      const meters = [...document.querySelectorAll('[role="meter"]')];
      const labels = meters.map((meter) => meter.getAttribute("aria-label") ?? "");
      const buttons = [...document.querySelectorAll("button")];
      const focusableControl = (label) => {
        const button = buttons.find(
          (candidate) => candidate.textContent?.trim() === label
        );
        const bounds = button?.getBoundingClientRect();
        return Boolean(
          button &&
          !button.disabled &&
          button.tabIndex >= 0 &&
          bounds &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      return {
        labels,
        noVerticalOverflow:
          Boolean(content) && content.scrollHeight <= content.clientHeight + 1,
        refreshFocusable: focusableControl("Refresh"),
        quitFocusable: focusableControl("Quit")
      };
    })()`)) as {
      labels: string[];
      noVerticalOverflow: boolean;
      refreshFocusable: boolean;
      quitFocusable: boolean;
    };
    if (
      panel.labels.length === 2 &&
      panel.labels.some((label) => label.startsWith("5-hour:")) &&
      panel.labels.some((label) => label.startsWith("Weekly:")) &&
      panel.noVerticalOverflow &&
      panel.refreshFocusable &&
      panel.quitFocusable
    ) {
      log("self-test-connected-panel-pass", {
        windows: panel.labels,
        noVerticalOverflow: panel.noVerticalOverflow,
        controlsFocusable: true,
      });
      return;
    }
    await delay(25);
  }
  throw new Error(
    "Connected two-window panel did not render without vertical overflow",
  );
}

async function verifyClaudeSetupStatesRendering(): Promise<void> {
  const settingsPath = getClaudeHookPaths().settingsPath;
  await fs.promises.writeFile(
    settingsPath,
    '{\n  "statusLine": { "type": "command", "command": "echo custom" }\n}\n',
    "utf8",
  );
  await reloadSelfTestRenderer();
  await waitForPanelCopy("Claude Code — Custom statusline found");

  await fs.promises.writeFile(settingsPath, "{\n", "utf8");
  await reloadSelfTestRenderer();
  await waitForPanelCopy("Claude Code setup failed");

  await fs.promises.writeFile(settingsPath, "{\n}\n", "utf8");
  await reloadSelfTestRenderer();
  await waitForPanelCopy("Claude Code — Setup required");
  log("self-test-claude-state-rendering-pass", {
    states: ["setup", "conflict", "error"],
  });
}

async function runSelfTest(): Promise<void> {
  if (!popup || !tray) {
    throw new Error("App was not initialized");
  }
  await waitForRenderer();
  if (
    !trayIconMetadata ||
    trayIconMetadata.scaleFactors.length !== trayRepresentations.length
  ) {
    throw new Error("Checked-in tray icon representations were not loaded");
  }
  log("self-test-icon-pass", {
    ...trayIconMetadata,
    packaged: app.isPackaged,
  });
  for (const severity of [
    "healthy",
    "warning",
    "critical",
  ] satisfies TraySeverity[]) {
    const stateImage = createTrayImage(severity);
    if (stateImage.getScaleFactors().length !== trayRepresentations.length) {
      throw new Error(`Tray state ${severity} is missing representations`);
    }
  }
  log("self-test-tray-states-pass");
  await verifyRendererBoundary();

  const snapshots = (await popup.webContents.executeJavaScript(
    "window.aiUsageMonitor.readQuota()",
  )) as unknown[];
  if (snapshots.length !== 2 || state.providerReads !== 0) {
    throw new Error("Read request did not return the immediate memory cache");
  }
  log("self-test-read-pass", {
    snapshots: snapshots.length,
    providerReads: state.providerReads,
  });
  await verifyPanelRendering();
  await verifyConnectedPanelRendering();
  await verifyClaudeSetupStatesRendering();

  const installButtonClicked =
    (await popup.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll("button")]
        .find((candidate) => candidate.textContent?.trim() === "Install hook");
      button?.click();
      return Boolean(button);
    })()`)) as boolean;
  await delay(25);
  const confirmationShown =
    (await popup.webContents.executeJavaScript(
      `document.querySelector("main")?.textContent?.includes(
        "This will back up and update Claude’s settings.json. Continue?"
      ) ?? false`,
    )) as boolean;
  if (
    !installButtonClicked ||
    !confirmationShown ||
    state.claudeHookInstalls !== 0
  ) {
    throw new Error("Claude hook confirmation boundary failed");
  }
  log("self-test-claude-confirmation-pass");

  const confirmClicked =
    (await popup.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll("button")]
        .find((candidate) => candidate.textContent?.trim() === "Confirm install");
      button?.click();
      return Boolean(button);
    })()`)) as boolean;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const pending =
      (await popup.webContents.executeJavaScript(
        `document.querySelector("main")?.textContent?.includes(
          "Open Claude Code CLI in a terminal"
        ) ?? false`,
      )) as boolean;
    if (pending) {
      break;
    }
    await delay(25);
  }
  const postInstallText =
    (await popup.webContents.executeJavaScript(
      `document.querySelector("main")?.textContent ?? ""`,
    )) as string;
  if (
    !confirmClicked ||
    Number(state.claudeHookInstalls) !== 1 ||
    !postInstallText.includes("send one message and wait for its reply") ||
    !postInstallText.includes("Claude Desktop won't complete setup.")
  ) {
    throw new Error("Claude hook isolated installation failed");
  }
  log("self-test-claude-install-pass", {
    isolated: true,
    installs: state.claudeHookInstalls,
  });

  const invalidInstallRejected =
    (await popup.webContents.executeJavaScript(
      `window.aiUsageMonitor
        .installClaudeHook({ confirmed: false })
        .then(() => false, () => true)`,
    )) as boolean;
  if (!invalidInstallRejected || Number(state.claudeHookInstalls) !== 1) {
    throw new Error("Invalid Claude hook install payload was not rejected");
  }
  log("self-test-invalid-claude-install-pass");

  const invalidListenerRejected =
    (await popup.webContents.executeJavaScript(`(() => {
      try {
        window.aiUsageMonitor.onQuotaUpdated(null);
        return false;
      } catch {
        return true;
      }
    })()`)) as boolean;
  if (!invalidListenerRejected) {
    throw new Error("Preload accepted an invalid quota update listener");
  }

  await popup.webContents.executeJavaScript(
    'window.aiUsageMonitor.forceRefresh({ reason: "user" })',
  );
  if (
    Number(state.refreshes) !== 1 ||
    Number(state.providerReads) !== 2 ||
    Number(state.broadcasts) !== 1
  ) {
    throw new Error("Forced refresh did not update the cached provider state");
  }
  log("self-test-refresh-pass");

  const invalidRefreshRejected =
    (await popup.webContents.executeJavaScript(
      `window.aiUsageMonitor
        .forceRefresh({ reason: "timer" })
        .then(() => false, () => true)`,
    )) as boolean;
  if (!invalidRefreshRejected || Number(state.refreshes) !== 1) {
    throw new Error("Invalid forced-refresh payload was not rejected");
  }
  log("self-test-invalid-refresh-pass");

  await popup.webContents.executeJavaScript(
    'window.aiUsageMonitor.forceRefresh({ reason: "user" })',
  );
  await popup.webContents.executeJavaScript(
    'window.aiUsageMonitor.forceRefresh({ reason: "user" })',
  );
  if (
    Number(state.refreshes) !== 3 ||
    Number(state.providerReads) !== 6 ||
    Number(state.notifications) !== 1 ||
    selfTestNotificationActivations.length !== 1
  ) {
    throw new Error("Third-failure notification policy failed at runtime");
  }
  log("self-test-failure-notification-pass", {
    refreshes: state.refreshes,
    notifications: state.notifications,
  });

  const activateNotification = selfTestNotificationActivations.shift();
  activateNotification?.();
  await delay(100);
  if (!popup.isVisible() || !popup.isFocused()) {
    throw new Error("Notification activation did not open the panel");
  }
  hidePopup("self-test-notification");
  log("self-test-notification-activation-pass");

  await handleSystemResume();
  await scheduleRefresh("poll");
  if (
    state.resumeRefreshes !== 1 ||
    state.pollRefreshes !== 1 ||
    state.refreshes !== 5 ||
    state.notifications !== 1
  ) {
    throw new Error("Resume or poll refresh lifecycle failed");
  }
  log("self-test-monitor-lifecycle-pass", {
    pollRefreshes: state.pollRefreshes,
    resumeRefreshes: state.resumeRefreshes,
  });

  const readsBeforeCachedRead = state.providerReads;
  await popup.webContents.executeJavaScript("window.aiUsageMonitor.readQuota()");
  if (state.providerReads !== readsBeforeCachedRead) {
    throw new Error("Cached read unexpectedly touched a provider");
  }
  log("self-test-cached-read-pass");

  const originalTray = tray;
  originalTray.destroy();
  const recreatedTray = ensureTray("self-test-explorer-restart");
  if (
    recreatedTray === originalTray ||
    recreatedTray.isDestroyed() ||
    state.trayRecreations !== 1
  ) {
    throw new Error("Tray recreation watchdog behavior failed");
  }
  log("self-test-tray-recreation-pass", {
    recreations: state.trayRecreations,
  });

  const trayBounds = tray.getBounds();
  showPopup(trayBounds, "self-test-focus");
  await delay(100);
  if (!popup.isFocused()) {
    throw new Error("Popup did not take focus after show");
  }
  log("self-test-focus-pass", { focused: popup.isFocused() });
  hidePopup("self-test-focus");

  for (let index = 0; index < 100; index += 1) {
    showPopup(trayBounds, "self-test");
    if (!popup.isVisible()) {
      throw new Error(`Toggle ${index + 1}: popup did not become visible`);
    }
    hidePopup("self-test");
    if (popup.isVisible()) {
      throw new Error(`Toggle ${index + 1}: popup did not hide`);
    }
  }
  log("self-test-toggle-pass", { toggles: 100 });

  const ticksBefore = state.backgroundTicks;
  await delay(650);
  const tickDelta = state.backgroundTicks - ticksBefore;
  if (tickDelta < 2) {
    throw new Error(`Background timer only advanced ${tickDelta} ticks`);
  }
  log("self-test-background-pass", { tickDelta, hidden: !popup.isVisible() });
  await popup.webContents.executeJavaScript("window.aiUsageMonitor.quit()");
  if (state.rendererQuitRequests !== 1) {
    throw new Error("Renderer quit request did not reach the validated handler");
  }
  log("self-test-quit-pass");
  log("self-test-pass", {
    skipTaskbarConfigured: true,
    popupFocusable: popup.isFocusable(),
  });
  quitting = true;
  app.quit();
}

ipcMain.handle(IPC_CHANNELS.readQuota, readQuota);
ipcMain.handle(IPC_CHANNELS.forceRefresh, forceRefresh);
ipcMain.handle(IPC_CHANNELS.readClaudeSetup, readClaudeSetup);
ipcMain.handle(IPC_CHANNELS.installClaudeHook, installClaudeHookFromRenderer);
ipcMain.handle(IPC_CHANNELS.quit, quitFromRenderer);

app.on("window-all-closed", () => {
  // A tray utility remains alive until its explicit Quit command.
});

app.whenReady().then(async () => {
  if (SELF_TEST) {
    selfTestOnboardingRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "aum-electron-onboarding-"),
    );
    const selfTestSettingsPath = path.join(
      selfTestOnboardingRoot,
      ".claude",
      "settings.json",
    );
    await fs.promises.mkdir(path.dirname(selfTestSettingsPath), {
      recursive: true,
    });
    await fs.promises.writeFile(selfTestSettingsPath, "{\n}\n", "utf8");
  }
  popup = createPopup();
  tray = createTray("startup");
  powerMonitor.on("resume", handleSystemResume);

  if (SELF_TEST) {
    selfTestHeartbeatTimer = setInterval(() => {
      state.backgroundTicks += 1;
    }, 250);
    selfTestHeartbeatTimer.unref();
    try {
      await runSelfTest();
    } catch (error) {
      log("self-test-fail", {
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack
          ? { stack: error.stack }
          : {}),
      });
      quitting = true;
      cleanupSelfTestOnboarding();
      app.exit(1);
    }
  } else {
    startBackgroundMonitoring();
    if (MANUAL_HARNESS) {
      setTimeout(() => {
        if (tray) {
          showPopup(tray.getBounds(), "manual-harness");
        }
      }, 750);
      log("manual-harness-ready", {
        expectedBehavior:
          "show focuses the popup; clicking outside emits blur and hides it",
      });
    }
  }
});

app.on("before-quit", () => {
  quitting = true;
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  if (trayWatchdogTimer) {
    clearInterval(trayWatchdogTimer);
  }
  if (selfTestHeartbeatTimer) {
    clearInterval(selfTestHeartbeatTimer);
  }
  activeNotifications.clear();
  codexProvider.dispose();
  cleanupSelfTestOnboarding();
});
