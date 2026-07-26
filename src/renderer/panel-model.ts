import {
  QUOTA_WINDOW_MINUTES,
  type ClaudeSetupState,
  type QuotaSnapshot,
  type QuotaWindow,
} from "../shared/contracts";

export const CLAUDE_STALE_AFTER_SECONDS = 5 * 60;

export type GaugeSeverity = "healthy" | "warning" | "critical" | "stale";

export type PanelState = {
  initialLoading: boolean;
  refreshing: boolean;
  snapshots: QuotaSnapshot[];
  error?: string;
};

export type PanelAction =
  | { type: "load-succeeded"; snapshots: QuotaSnapshot[] }
  | { type: "load-failed"; message: string }
  | { type: "refresh-started" }
  | { type: "refresh-succeeded"; snapshots: QuotaSnapshot[] }
  | { type: "refresh-failed"; message: string };

export const initialPanelState: PanelState = {
  initialLoading: true,
  refreshing: false,
  snapshots: [],
};

export function reducePanelState(
  state: PanelState,
  action: PanelAction,
): PanelState {
  switch (action.type) {
    case "load-succeeded":
      return {
        initialLoading: false,
        refreshing: false,
        snapshots: action.snapshots,
      };
    case "load-failed":
      return {
        ...state,
        initialLoading: false,
        refreshing: false,
        error: action.message,
      };
    case "refresh-started":
      return { ...state, refreshing: true, error: undefined };
    case "refresh-succeeded":
      return {
        initialLoading: false,
        refreshing: false,
        snapshots: action.snapshots,
      };
    case "refresh-failed":
      return {
        ...state,
        initialLoading: false,
        refreshing: false,
        error: action.message,
      };
  }
}

export function toRemainingPercent(usedPercent: number): number {
  return Math.round(Math.min(100, Math.max(0, 100 - usedPercent)));
}

export function getSeverity(
  usedPercent: number,
  stale = false,
): GaugeSeverity {
  if (stale) {
    return "stale";
  }
  if (usedPercent >= 90) {
    return "critical";
  }
  if (usedPercent >= 80) {
    return "warning";
  }
  return "healthy";
}

export function isClaudeSnapshotStale(
  snapshot: QuotaSnapshot,
  nowSeconds: number,
): boolean {
  return (
    snapshot.providerId === "claude" &&
    snapshot.connectionState === "connected" &&
    nowSeconds - snapshot.capturedAt > CLAUDE_STALE_AFTER_SECONDS
  );
}

export function orderQuotaWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return [...windows].sort((left, right) => {
    const leftOrder =
      left.windowMinutes === QUOTA_WINDOW_MINUTES.fiveHours ? 0 : 1;
    const rightOrder =
      right.windowMinutes === QUOTA_WINDOW_MINUTES.fiveHours ? 0 : 1;
    return leftOrder - rightOrder;
  });
}

export function getWindowLabel(windowMinutes: number): string {
  return windowMinutes === QUOTA_WINDOW_MINUTES.fiveHours
    ? "5-hour"
    : "Weekly";
}

export type Countdown = {
  due: boolean;
  label: string;
};

export function formatCountdown(
  resetsAt: number,
  nowSeconds: number,
): Countdown {
  const remaining = Math.max(0, resetsAt - nowSeconds);
  if (remaining === 0) {
    return { due: true, label: "Reset due · Refresh to update" };
  }

  const hours = Math.floor(remaining / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  const seconds = remaining % 60;
  if (hours > 0) {
    return { due: false, label: `Resets in ${hours}h ${minutes}m` };
  }
  if (minutes > 0) {
    return { due: false, label: `Resets in ${minutes}m ${seconds}s` };
  }
  return { due: false, label: `Resets in ${seconds}s` };
}

export function formatReadingAge(
  capturedAt: number,
  nowSeconds: number,
): string {
  const age = Math.max(0, nowSeconds - capturedAt);
  if (age < 10) {
    return "Updated now";
  }
  if (age < 60) {
    return `Updated ${age}s ago`;
  }
  if (age < 3_600) {
    return `Updated ${Math.floor(age / 60)}m ago`;
  }
  return `Updated ${Math.floor(age / 3_600)}h ago`;
}

export function getProviderName(providerId: string): string {
  if (providerId === "codex") {
    return "Codex";
  }
  if (providerId === "claude") {
    return "Claude Code";
  }
  if (providerId === "opencode") {
    return "OpenCode";
  }
  return providerId;
}

export type ProviderStatePresentation = {
  heading: string;
  body: string;
  badge: string;
  error: boolean;
};

export type ClaudeSetupPresentation = {
  heading: string;
  body: string;
  badge: string;
  canInstall: boolean;
  error: boolean;
};

export function canRenderClaudeQuota(
  state: ClaudeSetupState | null,
): boolean {
  return state?.status === "available";
}

export function advanceClaudeSetupFromSnapshots(
  state: ClaudeSetupState | null,
  snapshots: QuotaSnapshot[],
): ClaudeSetupState | null {
  if (state?.status !== "installed-pending") {
    return state;
  }
  return snapshots.some(
    (snapshot) =>
      snapshot.providerId === "claude" &&
      snapshot.connectionState === "connected",
  )
    ? { status: "available" }
    : state;
}

export function getClaudeSetupPresentation(
  state: ClaudeSetupState,
): ClaudeSetupPresentation {
  switch (state.status) {
    case "missing":
      return {
        heading: "Claude Code — Setup required",
        body:
          "Install the AI Usage Monitor hook to read Claude usage limits.",
        badge: "Setup",
        canInstall: true,
        error: false,
      };
    case "installed-pending":
      return {
        heading: "Claude Code",
        body:
          "Open Claude Code CLI in a terminal, accept workspace trust if asked, then send one message and wait for its reply. Claude Desktop won't complete setup.",
        badge: "CLI",
        canInstall: false,
        error: false,
      };
    case "conflict":
      return {
        heading: "Claude Code — Custom statusline found",
        body:
          "AI Usage Monitor won’t overwrite your existing statusline.",
        badge: "Conflict",
        canInstall: false,
        error: false,
      };
    case "error":
      return {
        heading: "Claude Code setup failed",
        body: state.message,
        badge: "Error",
        canInstall: true,
        error: true,
      };
    case "available":
      return {
        heading: "Waiting for Claude Code",
        body: "Restart or use Claude Code once to capture usage.",
        badge: "No data",
        canInstall: false,
        error: false,
      };
  }
}

export function getProviderStatePresentation(
  snapshot: QuotaSnapshot,
): ProviderStatePresentation {
  const name = getProviderName(snapshot.providerId);
  if (snapshot.connectionState === "unsupported") {
    return {
      heading: name,
      body: snapshot.error ?? "No quota API yet.",
      badge: "Not available",
      error: false,
    };
  }
  if (snapshot.connectionState === "no-data-yet") {
    return {
      heading:
        snapshot.providerId === "claude"
          ? "Waiting for Claude Code"
          : `Waiting for ${name}`,
      body:
        snapshot.providerId === "claude"
          ? "Start Claude Code once to capture usage."
          : "No usage reading is available yet.",
      badge: "No data",
      error: false,
    };
  }
  if (snapshot.connectionState === "not-connected") {
    return {
      heading: `${name} isn’t connected`,
      body:
        snapshot.error ?? "Sign in through the provider, then refresh.",
      badge: "Offline",
      error: false,
    };
  }
  return {
    heading: `Couldn’t refresh ${name}`,
    body: snapshot.error ?? "Try refreshing again.",
    badge: "Error",
    error: true,
  };
}

export function describeProviderState(
  snapshot: QuotaSnapshot,
  stale: boolean,
): string {
  const name = getProviderName(snapshot.providerId);
  if (stale) {
    return `${name} usage is stale`;
  }
  if (snapshot.connectionState === "connected") {
    return `${name} usage is connected`;
  }
  return `${name} usage state is ${snapshot.connectionState}`;
}
