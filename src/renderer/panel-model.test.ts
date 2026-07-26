import assert from "node:assert/strict";
import test from "node:test";
import {
  describeProviderState,
  advanceClaudeSetupFromSnapshots,
  canRenderClaudeQuota,
  formatCountdown,
  formatReadingAge,
  getConnectedProviderSeverity,
  getPanelSummaryPresentation,
  getProviderStatePresentation,
  getClaudeSetupPresentation,
  getSeverity,
  initialPanelState,
  isClaudeSnapshotStale,
  orderQuotaWindows,
  reducePanelState,
  toRemainingPercent,
} from "./panel-model";

test("derives Claude setup, pending, conflict, and retry presentation", () => {
  assert.equal(canRenderClaudeQuota(null), false);
  assert.equal(canRenderClaudeQuota({ status: "missing" }), false);
  assert.equal(canRenderClaudeQuota({ status: "conflict" }), false);
  assert.equal(canRenderClaudeQuota({ status: "available" }), true);
  assert.deepEqual(getClaudeSetupPresentation({ status: "missing" }), {
    heading: "Claude Code — Setup required",
    body: "Install the AI Usage Monitor hook to read Claude usage limits.",
    badge: "Setup",
    canInstall: true,
    error: false,
  });
  assert.equal(
    getClaudeSetupPresentation({ status: "installed-pending" }).body,
    "Open Claude Code CLI in a terminal, accept workspace trust if asked, then send one message and wait for its reply. Claude Desktop won't complete setup.",
  );
  assert.equal(
    getClaudeSetupPresentation({ status: "installed-pending" }).badge,
    "CLI",
  );
  assert.equal(
    getClaudeSetupPresentation({ status: "conflict" }).canInstall,
    false,
  );
  assert.deepEqual(
    getClaudeSetupPresentation({
      status: "error",
      message: "Safe failure.",
    }),
    {
      heading: "Claude Code setup failed",
      body: "Safe failure.",
      badge: "Error",
      canInstall: true,
      error: true,
    },
  );
});

test("only an owned pending setup advances when connected Claude data arrives", () => {
  const connectedClaude = [
    { ...snapshot(), providerId: "claude", connectionState: "connected" as const },
  ];
  assert.deepEqual(
    advanceClaudeSetupFromSnapshots(
      { status: "installed-pending" },
      connectedClaude,
    ),
    { status: "available" },
  );
  for (const setup of [
    null,
    { status: "missing" } as const,
    { status: "conflict" } as const,
    { status: "error", message: "Safe error." } as const,
  ]) {
    assert.equal(
      advanceClaudeSetupFromSnapshots(setup, connectedClaude),
      setup,
    );
  }
  assert.deepEqual(
    advanceClaudeSetupFromSnapshots(
      { status: "installed-pending" },
      [{ ...snapshot(), providerId: "claude", connectionState: "no-data-yet" }],
    ),
    { status: "installed-pending" },
  );
});
import {
  QUOTA_WINDOW_MINUTES,
  type ProviderConnectionState,
  type QuotaSnapshot,
} from "../shared/contracts";

const NOW = 1_800_000_000;

function snapshot(
  connectionState: ProviderConnectionState = "connected",
  usedPercent = 25,
): QuotaSnapshot {
  return {
    providerId: "claude",
    connectionState,
    windows:
      connectionState === "connected"
        ? [
            {
              label: "Weekly",
              usedPercent,
              windowMinutes: QUOTA_WINDOW_MINUTES.weekly,
              resetsAt: NOW + 7_261,
            },
            {
              label: "Five hours",
              usedPercent,
              windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
              resetsAt: NOW + 61,
            },
          ]
        : [],
    capturedAt: NOW,
    error: connectionState === "connected" ? undefined : "Fixture message.",
  };
}

test("rounds and clamps complementary remaining percentages", () => {
  assert.equal(toRemainingPercent(54.4), 46);
  assert.equal(toRemainingPercent(99.7), 0);
  assert.equal(toRemainingPercent(-20), 100);
  assert.equal(toRemainingPercent(120), 0);
});

test("selects all connected threshold rows including exhausted", () => {
  assert.equal(getSeverity(79.99), "healthy");
  assert.equal(getSeverity(80), "warning");
  assert.equal(getSeverity(89.99), "warning");
  assert.equal(getSeverity(90), "critical");
  assert.equal(getSeverity(100), "critical");
  assert.equal(toRemainingPercent(100), 0);
});

test("summarizes the lowest trustworthy current quota without forecasting", () => {
  const codex = {
    ...snapshot(),
    providerId: "codex",
    windows: [
      {
        label: "Five hours",
        usedPercent: 42,
        windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
        resetsAt: NOW + 7_200,
      },
      {
        label: "Weekly",
        usedPercent: 91,
        windowMinutes: QUOTA_WINDOW_MINUTES.weekly,
        resetsAt: NOW + 5 * 86_400,
      },
    ],
  };
  assert.deepEqual(getPanelSummaryPresentation([snapshot(), codex], NOW), {
    eyebrow: "CURRENT RISK",
    value: "9%",
    label: "lowest quota remaining",
    detail: "Codex · Weekly · Resets in 5d 0h 0m",
    badge: "Critical",
    tone: "critical",
  });
  assert.equal(getConnectedProviderSeverity(codex, NOW), "critical");
});

test("excludes reset-due and expired windows from current risk", () => {
  const codex = {
    ...snapshot(),
    providerId: "codex",
    windows: [
      {
        label: "Five hours",
        usedPercent: 100,
        windowMinutes: QUOTA_WINDOW_MINUTES.fiveHours,
        resetsAt: NOW,
      },
      {
        label: "Weekly",
        usedPercent: 82,
        windowMinutes: QUOTA_WINDOW_MINUTES.weekly,
        resetsAt: NOW + 1,
      },
    ],
  };

  assert.equal(getConnectedProviderSeverity(codex, NOW), "warning");
  assert.deepEqual(getPanelSummaryPresentation([codex], NOW), {
    eyebrow: "CURRENT RISK",
    value: "18%",
    label: "lowest quota remaining",
    detail: "Codex · Weekly · Resets in 1s",
    badge: "Warning",
    tone: "warning",
  });

  const resetDue = {
    ...codex,
    windows: codex.windows.map((window) => ({
      ...window,
      resetsAt: NOW,
    })),
  };
  assert.equal(getConnectedProviderSeverity(resetDue, NOW), "no-data");
  assert.deepEqual(getPanelSummaryPresentation([resetDue], NOW), {
    eyebrow: "CURRENT STATUS",
    value: "—",
    label: "quota reset due",
    detail: "Refresh to request the provider’s current quota.",
    badge: "Reset due",
    tone: "no-data",
  });

  const expired = {
    ...resetDue,
    windows: resetDue.windows.map((window) => ({
      ...window,
      resetsAt: NOW - 1,
    })),
  };
  assert.equal(getConnectedProviderSeverity(expired, NOW), "no-data");
  assert.equal(
    getPanelSummaryPresentation([expired], NOW).badge,
    "Reset due",
  );
});

test("summarizes stale, error, offline, and no-data states explicitly", () => {
  assert.deepEqual(
    getPanelSummaryPresentation([snapshot()], NOW + 301),
    {
      eyebrow: "CURRENT STATUS",
      value: "—",
      label: "fresh quota unavailable",
      detail: "Claude Code reading is older than 5 minutes.",
      badge: "Stale",
      tone: "stale",
    },
  );
  assert.equal(
    getPanelSummaryPresentation([snapshot("error")], NOW).tone,
    "error",
  );
  assert.equal(
    getPanelSummaryPresentation([snapshot("not-connected")], NOW).tone,
    "offline",
  );
  assert.equal(
    getPanelSummaryPresentation([snapshot("no-data-yet")], NOW).tone,
    "no-data",
  );
  assert.equal(
    getConnectedProviderSeverity(snapshot(), NOW + 301),
    "stale",
  );
});

test("derives stale Claude readings after five minutes and neutralizes them", () => {
  const value = snapshot();
  assert.equal(isClaudeSnapshotStale(value, NOW + 300), false);
  assert.equal(isClaudeSnapshotStale(value, NOW + 301), true);
  assert.equal(getSeverity(95, true), "stale");
  assert.equal(describeProviderState(value, true), "Claude Code usage is stale");
});

test("does not derive stale for non-connected or non-Claude snapshots", () => {
  assert.equal(isClaudeSnapshotStale(snapshot("no-data-yet"), NOW + 999), false);
  assert.equal(
    isClaudeSnapshotStale({ ...snapshot(), providerId: "codex" }, NOW + 999),
    false,
  );
});

test("orders five-hour before weekly and naturally omits absent windows", () => {
  const ordered = orderQuotaWindows(snapshot().windows);
  assert.deepEqual(
    ordered.map((window) => window.windowMinutes),
    [QUOTA_WINDOW_MINUTES.fiveHours, QUOTA_WINDOW_MINUTES.weekly],
  );
  assert.deepEqual(orderQuotaWindows([]), []);
});

test("formats countdown day boundaries and never renders negatives", () => {
  assert.deepEqual(formatCountdown(NOW + 86_399, NOW), {
    due: false,
    label: "Resets in 23h 59m",
  });
  assert.deepEqual(formatCountdown(NOW + 86_400, NOW), {
    due: false,
    label: "Resets in 1d 0h 0m",
  });
  assert.deepEqual(
    formatCountdown(NOW + 5 * 86_400 + 21 * 3_600 + 17 * 60, NOW),
    {
      due: false,
      label: "Resets in 5d 21h 17m",
    },
  );
  assert.deepEqual(formatCountdown(NOW + 7_261, NOW), {
    due: false,
    label: "Resets in 2h 1m",
  });
  assert.deepEqual(formatCountdown(NOW + 61, NOW), {
    due: false,
    label: "Resets in 1m 1s",
  });
  assert.deepEqual(formatCountdown(NOW, NOW + 1), {
    due: true,
    label: "Reset due · Refresh to update",
  });
  assert.deepEqual(formatCountdown(NOW, NOW), {
    due: true,
    label: "Reset due · Refresh to update",
  });
});

test("formats reading ages deterministically", () => {
  assert.equal(formatReadingAge(NOW, NOW + 5), "Updated now");
  assert.equal(formatReadingAge(NOW, NOW + 42), "Updated 42s ago");
  assert.equal(formatReadingAge(NOW, NOW + 360), "Updated 6m ago");
});

test("covers every non-connected provider-state row without gauges", () => {
  const cases: Array<{
    state: ProviderConnectionState;
    heading: string;
    body: string;
    badge: string;
    error: boolean;
  }> = [
    {
      state: "not-connected",
      heading: "Claude Code isn’t connected",
      body: "Fixture message.",
      badge: "Offline",
      error: false,
    },
    {
      state: "no-data-yet",
      heading: "Waiting for Claude Code",
      body: "Start Claude Code once to capture usage.",
      badge: "No data",
      error: false,
    },
    {
      state: "error",
      heading: "Couldn’t refresh Claude Code",
      body: "Fixture message.",
      badge: "Error",
      error: true,
    },
    {
      state: "unsupported",
      heading: "Claude Code",
      body: "Fixture message.",
      badge: "Not available",
      error: false,
    },
  ];
  for (const fixture of cases) {
    const value = snapshot(fixture.state);
    assert.equal(value.windows.length, 0);
    assert.match(describeProviderState(value, false), new RegExp(fixture.state));
    assert.deepEqual(getProviderStatePresentation(value), {
      heading: fixture.heading,
      body: fixture.body,
      badge: fixture.badge,
      error: fixture.error,
    });
  }
});

test("refresh keeps prior snapshots through failure and recovers", () => {
  const oldSnapshots = [snapshot()];
  let state = reducePanelState(initialPanelState, {
    type: "load-succeeded",
    snapshots: oldSnapshots,
  });
  state = reducePanelState(state, { type: "refresh-started" });
  assert.equal(state.refreshing, true);
  assert.equal(state.snapshots, oldSnapshots);

  state = reducePanelState(state, {
    type: "refresh-failed",
    message: "offline",
  });
  assert.equal(state.refreshing, false);
  assert.equal(state.snapshots, oldSnapshots);
  assert.equal(state.error, "offline");

  const freshSnapshots = [{ ...snapshot(), capturedAt: NOW + 10 }];
  state = reducePanelState(state, {
    type: "refresh-succeeded",
    snapshots: freshSnapshots,
  });
  assert.equal(state.error, undefined);
  assert.equal(state.snapshots, freshSnapshots);
});

test("whole-panel initial fetch failure remains refreshable", () => {
  const state = reducePanelState(initialPanelState, {
    type: "load-failed",
    message: "unavailable",
  });
  assert.equal(state.initialLoading, false);
  assert.equal(state.snapshots.length, 0);
  assert.equal(state.error, "unavailable");
  assert.equal(state.refreshing, false);
});
