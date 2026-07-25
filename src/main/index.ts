import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
  type IpcMainInvokeEvent,
  type NativeImage,
  type Rectangle,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  IPC_CHANNELS,
  isForceRefreshRequest,
  isQuotaSnapshot,
  isQuitRequestArguments,
  type QuotaSnapshot,
} from "../shared/contracts";
import { positionPopup } from "./position";
import { ClaudeQuotaProvider } from "./providers/claude";
import { CodexQuotaProvider } from "./providers/codex";

const POPUP_SIZE = { width: 340, height: 420 };
const SELF_TEST = process.argv.includes("--self-test");
const MANUAL_HARNESS = process.argv.includes("--manual-harness");
const LOG_PATH = process.env.AUM_SPIKE_LOG;

type RuntimeState = {
  backgroundTicks: number;
  refreshes: number;
  rendererQuitRequests: number;
};

const state: RuntimeState = {
  backgroundTicks: 0,
  refreshes: 0,
  rendererQuitRequests: 0,
};

let popup: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
const codexProvider = SELF_TEST
  ? {
      readQuota: async (): Promise<QuotaSnapshot> => ({
        providerId: "codex",
        connectionState: "not-connected",
        windows: [],
        capturedAt: Math.floor(Date.now() / 1_000),
        error: "Codex provider is disabled during the Electron self-test.",
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

async function readProviderSnapshots(): Promise<QuotaSnapshot[]> {
  const snapshots: QuotaSnapshot[] = [
    await codexProvider.readQuota(),
    await claudeProvider.readQuota(),
  ];

  if (!snapshots.every(isQuotaSnapshot)) {
    throw new Error("Internal quota snapshot failed contract validation");
  }
  return snapshots;
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
  return readProviderSnapshots();
}

async function forceRefresh(
  event: IpcMainInvokeEvent,
  payload: unknown,
): Promise<QuotaSnapshot[]> {
  assertTrustedSender(event);
  if (!isForceRefreshRequest(payload)) {
    throw new TypeError("Invalid forced-refresh request");
  }

  state.refreshes += 1;
  log("refresh", { refreshes: state.refreshes, reason: payload.reason });
  return readProviderSnapshots();
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

function createTrayImage(): NativeImage {
  const assetDirectory = path.join(app.getAppPath(), "assets", "icons");
  let image: NativeImage | undefined;

  for (const representation of trayRepresentations) {
    const assetPath = path.join(
      assetDirectory,
      `tray-${representation.size}.png`,
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
  log("tray-icon-loaded", trayIconMetadata);
  return image;
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

async function requestRefreshFromTray(): Promise<void> {
  state.refreshes += 1;
  log("refresh", { refreshes: state.refreshes, reason: "tray-menu" });
  await readProviderSnapshots();
}

function createTray(): Tray {
  const appTray = new Tray(createTrayImage());
  appTray.setToolTip("AI Usage Monitor");
  appTray.on("click", (_event, bounds) => togglePopup(bounds));
  appTray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Refresh", click: () => void requestRefreshFromTray() },
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
  log("tray-created", { trayBounds: appTray.getBounds() });
  return appTray;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

  const expectedKeys = ["forceRefresh", "quit", "readQuota"];
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
      return {
        text: main?.textContent ?? "",
        width: main?.getBoundingClientRect().width ?? 0,
        height: main?.getBoundingClientRect().height ?? 0,
        buttons: buttons.map((button) => button.textContent?.trim())
      };
    })()`)) as {
      text: string;
      width: number;
      height: number;
      buttons: Array<string | undefined>;
    };
    const expectedCopy = [
      "AI Usage",
      "Codex isn’t connected",
      "Waiting for Claude Code",
    ];
    if (
      panel.width === POPUP_SIZE.width &&
      panel.height === POPUP_SIZE.height &&
      expectedCopy.every((copy) => panel.text.includes(copy)) &&
      !panel.text.includes("OpenCode") &&
      panel.buttons.includes("Refresh") &&
      panel.buttons.includes("Quit")
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
  await verifyRendererBoundary();

  const snapshots = (await popup.webContents.executeJavaScript(
    "window.aiUsageMonitor.readQuota()",
  )) as unknown[];
  if (snapshots.length !== 2) {
    throw new Error("Read request did not return placeholder snapshots");
  }
  log("self-test-read-pass", { snapshots: snapshots.length });
  await verifyPanelRendering();

  await popup.webContents.executeJavaScript(
    'window.aiUsageMonitor.forceRefresh({ reason: "user" })',
  );
  if (state.refreshes !== 1) {
    throw new Error("Forced refresh request did not update main state");
  }
  log("self-test-refresh-pass");

  const invalidRefreshRejected =
    (await popup.webContents.executeJavaScript(
      `window.aiUsageMonitor
        .forceRefresh({ reason: "timer" })
        .then(() => false, () => true)`,
    )) as boolean;
  if (!invalidRefreshRejected || state.refreshes !== 1) {
    throw new Error("Invalid forced-refresh payload was not rejected");
  }
  log("self-test-invalid-refresh-pass");

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
ipcMain.handle(IPC_CHANNELS.quit, quitFromRenderer);

app.on("window-all-closed", () => {
  // A tray utility remains alive until its explicit Quit command.
});

app.whenReady().then(async () => {
  popup = createPopup();
  tray = createTray();

  setInterval(() => {
    state.backgroundTicks += 1;
    if (state.backgroundTicks % 20 === 0) {
      log("background-heartbeat", {
        backgroundTicks: state.backgroundTicks,
        popupVisible: popup?.isVisible(),
      });
    }
  }, 250).unref();

  if (SELF_TEST) {
    try {
      await runSelfTest();
  } catch (error) {
      log("self-test-fail", {
        error: error instanceof Error ? error.message : String(error),
      });
      quitting = true;
      app.exit(1);
    }
  } else if (MANUAL_HARNESS) {
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
});

app.on("before-quit", () => {
  quitting = true;
  codexProvider.dispose();
});
