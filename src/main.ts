import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
  type Rectangle,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { positionPopup } from "./position";

const POPUP_SIZE = { width: 340, height: 420 };
const SELF_TEST = process.argv.includes("--self-test");
const MANUAL_HARNESS = process.argv.includes("--manual-harness");
const LOG_PATH = process.env.AUM_SPIKE_LOG;

type SpikeState = {
  backgroundTicks: number;
  buttonClicks: number;
  refreshes: number;
};

const state: SpikeState = {
  backgroundTicks: 0,
  buttonClicks: 0,
  refreshes: 0,
};

let popup: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

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

function sendState(): void {
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send("state:update", state);
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

function refresh(): void {
  state.refreshes += 1;
  sendState();
  log("refresh", { refreshes: state.refreshes });
}

function createTrayImage() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">',
    '<rect width="32" height="32" rx="7" fill="#2563eb"/>',
    '<path d="M8 23L14 9h4l6 14h-4l-1.2-3H13l-1.2 3z" fill="white"/>',
    "</svg>",
  ].join("");
  return nativeImage
    .createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    )
    .resize({ width: 16, height: 16 });
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
      preload: path.join(__dirname, "preload.js"),
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
  window.webContents.on("did-finish-load", () => {
    sendState();
    log("renderer-ready");
  });
  void window.loadFile(path.join(__dirname, "..", "static", "index.html"));
  return window;
}

function createTray(): Tray {
  const appTray = new Tray(createTrayImage());
  appTray.setToolTip("AI Usage Monitor tray spike");
  appTray.on("click", (_event, bounds) => togglePopup(bounds));
  appTray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Refresh", click: refresh },
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

async function runSelfTest(): Promise<void> {
  if (!popup || !tray) {
    throw new Error("Spike was not initialized");
  }
  await new Promise<void>((resolve) => {
    if (popup?.webContents.isLoading()) {
      popup.webContents.once("did-finish-load", () => resolve());
    } else {
      resolve();
    }
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

  refresh();
  if (state.refreshes !== 1) {
    throw new Error("Refresh command did not update state");
  }
  log("self-test-refresh-pass");
  log("self-test-pass", {
    skipTaskbarConfigured: true,
    popupFocusable: popup.isFocusable(),
  });
  quitting = true;
  app.quit();
}

ipcMain.handle("state:get", () => state);
ipcMain.handle("button:click", () => {
  state.buttonClicks += 1;
  sendState();
  log("button-click", {
    buttonClicks: state.buttonClicks,
    focused: popup?.isFocused(),
  });
  return state;
});

app.on("window-all-closed", () => {
  // A tray utility remains alive until its explicit Quit command.
});

app.whenReady().then(async () => {
  popup = createPopup();
  tray = createTray();

  setInterval(() => {
    state.backgroundTicks += 1;
    sendState();
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
      process.exitCode = 1;
      quitting = true;
      app.quit();
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
});
