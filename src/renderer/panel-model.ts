import {
  QUOTA_WINDOW_MINUTES,
  type ClaudeSetupState,
  type QuotaCalculatedForecastEstimate,
  type QuotaForecast,
  type QuotaReport,
  type QuotaSnapshot,
  type QuotaWindow,
} from "../shared/contracts";

export const CLAUDE_STALE_AFTER_SECONDS = 5 * 60;

export type GaugeSeverity = "healthy" | "warning" | "critical" | "stale";
export type PresentationTone =
  | GaugeSeverity
  | "offline"
  | "no-data"
  | "error";

export type PanelState = {
  initialLoading: boolean;
  refreshing: boolean;
  snapshots: QuotaSnapshot[];
  forecasts: QuotaForecast[];
  error?: string;
};

export type PanelAction =
  | { type: "load-succeeded"; report: QuotaReport }
  | { type: "load-failed"; message: string }
  | { type: "refresh-started" }
  | { type: "refresh-succeeded"; report: QuotaReport }
  | { type: "refresh-failed"; message: string };

export const initialPanelState: PanelState = {
  initialLoading: true,
  refreshing: false,
  snapshots: [],
  forecasts: [],
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
        snapshots: action.report.snapshots,
        forecasts: action.report.forecasts,
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
        snapshots: action.report.snapshots,
        forecasts: action.report.forecasts,
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

export function getConnectedProviderSeverity(
  snapshot: QuotaSnapshot,
  nowSeconds: number,
): GaugeSeverity | "no-data" {
  if (isClaudeSnapshotStale(snapshot, nowSeconds)) {
    return "stale";
  }
  let worstUsedPercent: number | undefined;
  for (const window of snapshot.windows) {
    if (window.resetsAt <= nowSeconds) {
      continue;
    }
    worstUsedPercent =
      worstUsedPercent === undefined
        ? window.usedPercent
        : Math.max(worstUsedPercent, window.usedPercent);
  }
  return worstUsedPercent === undefined
    ? "no-data"
    : getSeverity(worstUsedPercent);
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

  const days = Math.floor(remaining / 86_400);
  const hours = Math.floor((remaining % 86_400) / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  const seconds = remaining % 60;
  if (days > 0) {
    return {
      due: false,
      label: `Resets in ${days}d ${hours}h ${minutes}m`,
    };
  }
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

export function formatForecast(
  forecast: QuotaForecast | undefined,
  nowSeconds: number,
  locales?: Intl.LocalesArgument,
  timeZone?: string,
  pausedForStaleData = false,
): string {
  if (pausedForStaleData || forecast?.state === "stale-paused") {
    const retained =
      forecast?.state === "stale-paused"
        ? forecast.retainedEstimate
        : forecast?.state === "safe-through-reset" ||
            forecast?.state === "projected-runout" ||
            forecast?.state === "exhausted"
          ? forecast
          : undefined;
    return retained
      ? `Forecast paused — data stale · Last estimate: ${formatEstimate(
          retained,
          nowSeconds,
          locales,
          timeZone,
          true,
        )}`
      : "Forecast paused — data stale";
  }
  if (!forecast || forecast.state === "unavailable-error") {
    return "Forecast unavailable";
  }
  if (forecast.state === "insufficient") {
    return "Forecast · Not enough history";
  }
  if (forecast.state === "exhausted") {
    return "Forecast · Limit reached";
  }
  if (
    forecast.state === "projected-runout" &&
    forecast.projectedRunoutAt <= nowSeconds
  ) {
    return "Forecast unavailable";
  }
  return `Forecast · ${formatEstimate(
    forecast,
    nowSeconds,
    locales,
    timeZone,
    false,
  )}`;
}

function formatEstimate(
  forecast: QuotaCalculatedForecastEstimate,
  nowSeconds: number,
  locales: Intl.LocalesArgument | undefined,
  timeZone: string | undefined,
  retained: boolean,
): string {
  if (forecast.state === "exhausted") {
    return "Limit reached";
  }
  const confidence = `${
    forecast.confidence === "high" ? "High" : "Medium"
  } confidence`;
  if (forecast.state === "safe-through-reset") {
    return `Safe through reset · ${confidence}`;
  }
  const projectedAt = forecast.projectedRunoutAt;
  const timestamp = new Intl.DateTimeFormat(locales, {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(projectedAt * 1_000));
  return retained
    ? `Runout around ${timestamp} · ${confidence}`
    : `May run out around ${timestamp} (${formatForecastDuration(
        projectedAt - nowSeconds,
      )}) · ${confidence}`;
}

function formatForecastDuration(seconds: number): string {
  const totalMinutes = Math.max(1, Math.ceil(seconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `in ${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `in ${hours}h ${minutes}m`;
  }
  return `in ${minutes}m`;
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

export type PanelSummaryPresentation = {
  eyebrow: string;
  value: string;
  label: string;
  detail: string;
  badge: string;
  tone: PresentationTone;
};

export function getPanelSummaryPresentation(
  snapshots: QuotaSnapshot[],
  nowSeconds: number,
): PanelSummaryPresentation {
  let lowest:
    | {
        snapshot: QuotaSnapshot;
        window: QuotaWindow;
        remainingPercent: number;
      }
    | undefined;

  for (const snapshot of snapshots) {
    if (
      snapshot.connectionState !== "connected" ||
      isClaudeSnapshotStale(snapshot, nowSeconds)
    ) {
      continue;
    }
    for (const window of snapshot.windows) {
      if (window.resetsAt <= nowSeconds) {
        continue;
      }
      const remainingPercent = toRemainingPercent(window.usedPercent);
      if (!lowest || remainingPercent < lowest.remainingPercent) {
        lowest = { snapshot, window, remainingPercent };
      }
    }
  }

  if (lowest) {
    const tone = getSeverity(lowest.window.usedPercent);
    return {
      eyebrow: "CURRENT RISK",
      value: `${lowest.remainingPercent}%`,
      label: "lowest quota remaining",
      detail: `${getProviderName(lowest.snapshot.providerId)} · ${getWindowLabel(lowest.window.windowMinutes)} · ${formatCountdown(lowest.window.resetsAt, nowSeconds).label}`,
      badge:
        tone === "critical"
          ? "Critical"
          : tone === "warning"
            ? "Warning"
            : "Healthy",
      tone,
    };
  }

  if (
    snapshots.some((snapshot) =>
      isClaudeSnapshotStale(snapshot, nowSeconds),
    )
  ) {
    return {
      eyebrow: "CURRENT STATUS",
      value: "—",
      label: "fresh quota unavailable",
      detail: "Claude Code reading is older than 5 minutes.",
      badge: "Stale",
      tone: "stale",
    };
  }

  if (
    snapshots.some(
      (snapshot) =>
        snapshot.connectionState === "connected" &&
        snapshot.windows.length > 0 &&
        snapshot.windows.every((window) => window.resetsAt <= nowSeconds),
    )
  ) {
    return {
      eyebrow: "CURRENT STATUS",
      value: "—",
      label: "quota reset due",
      detail: "Refresh to request the provider’s current quota.",
      badge: "Reset due",
      tone: "no-data",
    };
  }

  if (snapshots.some((snapshot) => snapshot.connectionState === "error")) {
    return {
      eyebrow: "CURRENT STATUS",
      value: "—",
      label: "usage unavailable",
      detail: "A provider refresh failed. Check the details below.",
      badge: "Error",
      tone: "error",
    };
  }

  if (
    snapshots.some(
      (snapshot) => snapshot.connectionState === "not-connected",
    )
  ) {
    return {
      eyebrow: "CURRENT STATUS",
      value: "—",
      label: "provider offline",
      detail: "Connect a provider, then refresh its reading.",
      badge: "Offline",
      tone: "offline",
    };
  }

  return {
    eyebrow: "CURRENT STATUS",
    value: "—",
    label: "waiting for quota data",
    detail: "Complete setup or wait for the first provider reading.",
    badge: "No data",
    tone: "no-data",
  };
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
