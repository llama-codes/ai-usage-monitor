import { useEffect, useReducer, useState } from "react";
import type { QuotaSnapshot, QuotaWindow } from "../shared/contracts";
import {
  describeProviderState,
  formatCountdown,
  formatReadingAge,
  getProviderName,
  getProviderStatePresentation,
  getSeverity,
  getWindowLabel,
  initialPanelState,
  isClaudeSnapshotStale,
  orderQuotaWindows,
  reducePanelState,
  toRemainingPercent,
} from "./panel-model";
import {
  controlTokens,
  gaugeTokens,
  panelTokens,
  providerTokens,
  severityTokens,
  stateTokens,
} from "./theme/tokens";

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function useNowSeconds(): number {
  const [nowSeconds, setNowSeconds] = useState(currentUnixSeconds);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowSeconds(currentUnixSeconds());
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return nowSeconds;
}

function DialIcon({ className }: { className: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
    >
      <path
        d="M4.5 15.5a8 8 0 1 1 15 0"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
      <path
        d="m12 12 4-3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
      <circle cx="12" cy="12" fill="currentColor" r="1.5" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  const className = spinning ? controlTokens.spinner : controlTokens.icon;
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
    >
      <path
        d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4m-4 5a8 8 0 0 0 14.9 3M20 20v-4h-4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function PowerIcon() {
  return (
    <svg
      aria-hidden="true"
      className={controlTokens.icon}
      fill="none"
      viewBox="0 0 24 24"
    >
      <path
        d="M12 3v9m5.7-6.7a8 8 0 1 1-11.4 0"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function ProviderMark({ providerId }: { providerId: string }) {
  const className =
    providerId === "claude"
      ? providerTokens.claudeMark
      : providerTokens.codexMark;
  return (
    <span aria-hidden="true" className={className}>
      {providerId === "claude" ? "C" : "X"}
    </span>
  );
}

function Gauge({
  quotaWindow,
  nowSeconds,
  stale,
}: {
  quotaWindow: QuotaWindow;
  nowSeconds: number;
  stale: boolean;
}) {
  const remainingPercent = toRemainingPercent(quotaWindow.usedPercent);
  const severity = getSeverity(quotaWindow.usedPercent, stale);
  const tokens = severityTokens[severity];
  const countdown = formatCountdown(quotaWindow.resetsAt, nowSeconds);
  const label = getWindowLabel(quotaWindow.windowMinutes);

  return (
    <div
      aria-label={`${label}: ${remainingPercent}% quota remaining. ${countdown.label}`}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={remainingPercent}
      className={gaugeTokens.row}
      role="meter"
    >
      <div className={gaugeTokens.heading}>
        <span className={gaugeTokens.label}>{label}</span>
        <span className={tokens.remaining}>{remainingPercent}% left</span>
      </div>
      <div
        aria-hidden="true"
        className={gaugeTokens.track}
        role="presentation"
      >
        <div
          className={tokens.fill}
          style={{ width: `${remainingPercent}%` }}
        />
      </div>
      <div className={gaugeTokens.meta}>
        <span className={gaugeTokens.countdown}>{countdown.label}</span>
        {stale ? (
          <span className={gaugeTokens.staleHint}>
            Open Claude Code to update.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ConnectedProviderCard({ snapshot }: { snapshot: QuotaSnapshot }) {
  const nowSeconds = useNowSeconds();
  const stale = isClaudeSnapshotStale(snapshot, nowSeconds);
  const windows = orderQuotaWindows(snapshot.windows);
  const name = getProviderName(snapshot.providerId);

  return (
    <section
      aria-labelledby={`${snapshot.providerId}-heading`}
      className={providerTokens.card}
    >
      <p aria-live="polite" className="sr-only">
        {describeProviderState(snapshot, stale)}
      </p>
      <div className={providerTokens.header}>
        <div className={providerTokens.identity}>
          <ProviderMark providerId={snapshot.providerId} />
          <h2 className={providerTokens.name} id={`${snapshot.providerId}-heading`}>
            {name}
          </h2>
          {stale ? (
            <span className={stateTokens.staleBadge}>Stale</span>
          ) : null}
        </div>
        <span className={providerTokens.age}>
          {formatReadingAge(snapshot.capturedAt, nowSeconds)}
        </span>
      </div>
      {windows.length > 0 ? (
        <div className={providerTokens.gaugeStack}>
          {windows.map((quotaWindow) => (
            <Gauge
              key={quotaWindow.windowMinutes}
              nowSeconds={nowSeconds}
              quotaWindow={quotaWindow}
              stale={stale}
            />
          ))}
        </div>
      ) : (
        <p className={stateTokens.body}>No quota windows were reported.</p>
      )}
    </section>
  );
}

function ProviderStateCard({ snapshot }: { snapshot: QuotaSnapshot }) {
  const presentation = getProviderStatePresentation(snapshot);

  return (
    <section
      aria-labelledby={`${snapshot.providerId}-state-heading`}
      className={
        presentation.error ? stateTokens.errorCard : stateTokens.card
      }
    >
      <p aria-live="polite" className="sr-only">
        {describeProviderState(snapshot, false)}
      </p>
      <div className={stateTokens.headingRow}>
        <h2
          className={
            presentation.error
              ? stateTokens.errorHeading
              : stateTokens.heading
          }
          id={`${snapshot.providerId}-state-heading`}
        >
          {presentation.heading}
        </h2>
        <span className={stateTokens.badge}>{presentation.badge}</span>
      </div>
      <p
        className={
          presentation.error ? stateTokens.errorBody : stateTokens.body
        }
      >
        {presentation.body}
      </p>
    </section>
  );
}

function MissingProviderCard({ providerId }: { providerId: string }) {
  const name = getProviderName(providerId);
  return (
    <section className={stateTokens.errorCard}>
      <div className={stateTokens.headingRow}>
        <h2 className={stateTokens.errorHeading}>
          Couldn’t refresh {name}
        </h2>
        <span className={stateTokens.badge}>Error</span>
      </div>
      <p className={stateTokens.errorBody}>
        No provider snapshot was returned.
      </p>
    </section>
  );
}

function ProviderSection({
  providerId,
  snapshots,
}: {
  providerId: string;
  snapshots: QuotaSnapshot[];
}) {
  const snapshot = snapshots.find((item) => item.providerId === providerId);
  if (!snapshot) {
    return <MissingProviderCard providerId={providerId} />;
  }
  return snapshot.connectionState === "connected" ? (
    <ConnectedProviderCard snapshot={snapshot} />
  ) : (
    <ProviderStateCard snapshot={snapshot} />
  );
}

function LoadingState() {
  return (
    <section aria-live="polite" className={stateTokens.card} role="status">
      <h2 className={stateTokens.heading}>Reading usage…</h2>
      <p className={stateTokens.body}>
        Checking Codex and the latest Claude Code reading.
      </p>
    </section>
  );
}

function PanelFailure({ message }: { message: string }) {
  return (
    <section aria-live="polite" className={stateTokens.errorCard} role="status">
      <h2 className={stateTokens.errorHeading}>Usage unavailable</h2>
      <p className={stateTokens.errorBody}>{message}</p>
    </section>
  );
}

function RefreshFailure({ message }: { message: string }) {
  return (
    <section aria-live="polite" className={stateTokens.errorCard} role="status">
      <h2 className={stateTokens.errorHeading}>Refresh failed</h2>
      <p className={stateTokens.errorBody}>
        {message} Previous readings are still shown.
      </p>
    </section>
  );
}

export function App() {
  const [panelState, dispatch] = useReducer(
    reducePanelState,
    initialPanelState,
  );

  useEffect(() => {
    let active = true;
    const unsubscribe = window.aiUsageMonitor.onQuotaUpdated((snapshots) => {
      if (active) {
        dispatch({ type: "load-succeeded", snapshots });
      }
    });
    void window.aiUsageMonitor.readQuota().then(
      (snapshots) => {
        if (active) {
          dispatch({ type: "load-succeeded", snapshots });
        }
      },
      (error: unknown) => {
        if (active) {
          dispatch({
            type: "load-failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function refresh(): Promise<void> {
    dispatch({ type: "refresh-started" });
    try {
      const snapshots = await window.aiUsageMonitor.forceRefresh({
        reason: "user",
      });
      dispatch({ type: "refresh-succeeded", snapshots });
    } catch (error) {
      dispatch({
        type: "refresh-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const refreshDisabled =
    panelState.initialLoading || panelState.refreshing;
  const refreshLabel = panelState.initialLoading
    ? "Reading…"
    : panelState.refreshing
      ? "Refreshing…"
      : "Refresh";

  return (
    <main className={panelTokens.shell}>
      <header className={panelTokens.header}>
        <span className={panelTokens.headerMark}>
          <DialIcon className={panelTokens.headerMarkIcon} />
        </span>
        <div className={panelTokens.headerText}>
          <h1 className={panelTokens.title}>AI Usage</h1>
          <p className={panelTokens.subtitle}>Quota remaining</p>
        </div>
      </header>

      <div className={panelTokens.content}>
        {panelState.initialLoading ? <LoadingState /> : null}
        {panelState.error && panelState.snapshots.length === 0 ? (
          <PanelFailure message={panelState.error} />
        ) : null}
        {panelState.error && panelState.snapshots.length > 0 ? (
          <RefreshFailure message={panelState.error} />
        ) : null}
        {!panelState.initialLoading && panelState.snapshots.length > 0 ? (
          <>
            <ProviderSection
              providerId="codex"
              snapshots={panelState.snapshots}
            />
            <ProviderSection
              providerId="claude"
              snapshots={panelState.snapshots}
            />
          </>
        ) : null}
        {!panelState.initialLoading &&
        panelState.snapshots.length === 0 &&
        !panelState.error ? (
          <PanelFailure message="No provider snapshots were returned." />
        ) : null}
      </div>

      <footer className={panelTokens.footer}>
        <button
          aria-label={
            panelState.initialLoading
              ? "Reading usage"
              : panelState.refreshing
                ? "Refreshing usage"
                : "Refresh usage"
          }
          className={controlTokens.refresh}
          disabled={refreshDisabled}
          onClick={() => void refresh()}
          type="button"
        >
          <RefreshIcon spinning={panelState.refreshing} />
          {refreshLabel}
        </button>
        <button
          className={controlTokens.quit}
          onClick={() => void window.aiUsageMonitor.quit()}
          type="button"
        >
          <PowerIcon />
          Quit
        </button>
      </footer>
    </main>
  );
}
