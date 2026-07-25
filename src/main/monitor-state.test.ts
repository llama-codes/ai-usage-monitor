import assert from "node:assert/strict";
import test from "node:test";
import {
  didProviderRefreshFail,
  FAILURE_NOTIFICATION_THRESHOLD,
  getWorstTrustworthySeverity,
  POLL_INTERVAL_MS,
  QuotaMonitorPolicy,
} from "./monitor-state";
import {
  QUOTA_WINDOW_MINUTES,
  type ProviderConnectionState,
  type QuotaSnapshot,
} from "../shared/contracts";

const NOW = 1_800_000_000;

function snapshot(options: {
  providerId?: string;
  state?: ProviderConnectionState;
  usedPercent?: number;
  windowMinutes?: 300 | 10_080;
  resetsAt?: number;
  capturedAt?: number;
} = {}): QuotaSnapshot {
  const state = options.state ?? "connected";
  return {
    providerId: options.providerId ?? "codex",
    connectionState: state,
    windows:
      state === "connected"
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
    capturedAt: options.capturedAt ?? NOW,
    ...(state === "error" ? { error: "Fixture failure." } : {}),
  };
}

test("uses an exact sixty-second poll interval", () => {
  assert.equal(POLL_INTERVAL_MS, 60_000);
});

test("selects the worst trustworthy connected window", () => {
  assert.equal(
    getWorstTrustworthySeverity(
      [snapshot({ usedPercent: 40 }), snapshot({ usedPercent: 80 })],
      NOW,
    ),
    "warning",
  );
  assert.equal(
    getWorstTrustworthySeverity(
      [snapshot({ usedPercent: 89 }), snapshot({ usedPercent: 90 })],
      NOW,
    ),
    "critical",
  );
  assert.equal(
    getWorstTrustworthySeverity([snapshot({ usedPercent: 79.9 })], NOW),
    "healthy",
  );
});

test("stale Claude data cannot escalate tray severity or notify", () => {
  const policy = new QuotaMonitorPolicy();
  const staleClaude = snapshot({
    providerId: "claude",
    usedPercent: 100,
    capturedAt: NOW - 301,
  });
  const decision = policy.evaluate({
    snapshots: [snapshot({ usedPercent: 20 }), staleClaude],
    refreshFailed: false,
    nowSeconds: NOW,
  });
  assert.equal(decision.traySeverity, "healthy");
  assert.deepEqual(decision.notifications, []);
});

test("cold start is warning and stale-only data retains the last trustworthy state", () => {
  const policy = new QuotaMonitorPolicy();
  assert.equal(
    policy.evaluate({
      snapshots: [snapshot({ state: "no-data-yet" })],
      refreshFailed: false,
      nowSeconds: NOW,
    }).traySeverity,
    "warning",
  );
  assert.equal(
    policy.evaluate({
      snapshots: [snapshot({ usedPercent: 95 })],
      refreshFailed: false,
      nowSeconds: NOW,
    }).traySeverity,
    "critical",
  );
  assert.equal(
    policy.evaluate({
      snapshots: [
        snapshot({
          providerId: "claude",
          usedPercent: 10,
          capturedAt: NOW - 301,
        }),
      ],
      refreshFailed: false,
      nowSeconds: NOW,
    }).traySeverity,
    "critical",
  );
});

test("provider failure warns unless a trustworthy critical window outranks it", () => {
  const policy = new QuotaMonitorPolicy();
  assert.equal(
    policy.evaluate({
      snapshots: [snapshot({ usedPercent: 20 })],
      refreshFailed: true,
      nowSeconds: NOW,
    }).traySeverity,
    "warning",
  );
  assert.equal(
    policy.evaluate({
      snapshots: [snapshot({ usedPercent: 95 })],
      refreshFailed: true,
      nowSeconds: NOW,
    }).traySeverity,
    "critical",
  );
});

test("notifies once on the third consecutive refresh failure and resets after success", () => {
  const policy = new QuotaMonitorPolicy();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const decision = policy.evaluate({
      snapshots: [snapshot({ state: "error" })],
      refreshFailed: true,
      nowSeconds: NOW,
    });
    assert.equal(decision.consecutiveFailures, attempt);
    assert.equal(
      decision.notifications.filter(
        (notification) => notification.kind === "refresh-failure",
      ).length,
      attempt === FAILURE_NOTIFICATION_THRESHOLD ? 1 : 0,
    );
  }
  assert.equal(
    policy.evaluate({
      snapshots: [snapshot()],
      refreshFailed: false,
      nowSeconds: NOW,
    }).consecutiveFailures,
    0,
  );
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const decision = policy.evaluate({
      snapshots: [snapshot({ state: "error" })],
      refreshFailed: true,
      nowSeconds: NOW,
    });
    assert.equal(
      decision.notifications.some(
        (notification) => notification.kind === "refresh-failure",
      ),
      attempt === 3,
    );
  }
});

test("only provider errors count as refresh execution failures", () => {
  assert.equal(
    didProviderRefreshFail([snapshot({ state: "not-connected" })]),
    false,
  );
  assert.equal(
    didProviderRefreshFail([snapshot({ state: "no-data-yet" })]),
    false,
  );
  assert.equal(didProviderRefreshFail([snapshot({ state: "error" })]), true);
});

test("deduplicates thresholds by provider, duration, reset and threshold", () => {
  const policy = new QuotaMonitorPolicy();
  const first = policy.evaluate({
    snapshots: [snapshot({ usedPercent: 85 })],
    refreshFailed: false,
    nowSeconds: NOW,
  });
  assert.deepEqual(
    first.notifications.map((notification) =>
      notification.kind === "threshold" ? notification.threshold : -1,
    ),
    [80],
  );
  assert.deepEqual(
    policy.evaluate({
      snapshots: [snapshot({ usedPercent: 89 })],
      refreshFailed: false,
      nowSeconds: NOW,
    }).notifications,
    [],
  );
  policy.evaluate({
    snapshots: [snapshot({ state: "error" })],
    refreshFailed: true,
    nowSeconds: NOW,
  });
  assert.deepEqual(
    policy.evaluate({
      snapshots: [snapshot({ usedPercent: 85 })],
      refreshFailed: false,
      nowSeconds: NOW,
    }).notifications,
    [],
  );
  assert.deepEqual(
    policy
      .evaluate({
        snapshots: [snapshot({ usedPercent: 95 })],
        refreshFailed: false,
        nowSeconds: NOW,
      })
      .notifications.map((notification) =>
        notification.kind === "threshold" ? notification.threshold : -1,
      ),
    [90],
  );
  assert.deepEqual(
    policy
      .evaluate({
        snapshots: [snapshot({ usedPercent: 100 })],
        refreshFailed: false,
        nowSeconds: NOW,
      })
      .notifications.map((notification) =>
        notification.kind === "threshold" ? notification.threshold : -1,
      ),
    [100],
  );
  assert.deepEqual(
    policy.evaluate({
      snapshots: [snapshot({ usedPercent: 100 })],
      refreshFailed: false,
      nowSeconds: NOW,
    }).notifications,
    [],
  );
});

test("a new reset key can notify again and first observation emits every reached threshold", () => {
  const policy = new QuotaMonitorPolicy();
  const first = policy.evaluate({
    snapshots: [snapshot({ usedPercent: 95 })],
    refreshFailed: false,
    nowSeconds: NOW,
  });
  assert.deepEqual(
    first.notifications.map((notification) =>
      notification.kind === "threshold" ? notification.threshold : -1,
    ),
    [80, 90],
  );
  const nextReset = policy.evaluate({
    snapshots: [snapshot({ usedPercent: 85, resetsAt: NOW + 7_200 })],
    refreshFailed: false,
    nowSeconds: NOW,
  });
  assert.deepEqual(
    nextReset.notifications.map((notification) =>
      notification.kind === "threshold" ? notification.threshold : -1,
    ),
    [80],
  );
});

test("expired windows never notify or create repeatable threshold keys", () => {
  const policy = new QuotaMonitorPolicy();
  for (const resetsAt of [NOW - 1, NOW]) {
    const decision = policy.evaluate({
      snapshots: [snapshot({ usedPercent: 100, resetsAt })],
      refreshFailed: false,
      nowSeconds: NOW,
    });
    assert.deepEqual(decision.notifications, []);
  }

  assert.deepEqual(
    policy.evaluate({
      snapshots: [snapshot({ usedPercent: 100, resetsAt: NOW + 1 })],
      refreshFailed: false,
      nowSeconds: NOW,
    }).notifications.map((notification) =>
      notification.kind === "threshold" ? notification.threshold : -1,
    ),
    [80, 90, 100],
  );
});
