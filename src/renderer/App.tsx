import { useCallback, useEffect, useState } from "react";
import type { QuotaSnapshot } from "../shared/contracts";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; snapshots: QuotaSnapshot[] }
  | { status: "error"; message: string };

export function App() {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const snapshots = await window.aiUsageMonitor.readQuota();
      setLoadState({ status: "ready", snapshots });
    } catch (error) {
      setLoadState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    try {
      const snapshots = await window.aiUsageMonitor.forceRefresh({
        reason: "user",
      });
      setLoadState({ status: "ready", snapshots });
    } catch (error) {
      setLoadState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <main className="h-[420px] w-[340px] overflow-hidden border border-slate-700 bg-slate-950 p-6 text-slate-50">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
          Scaffold
        </p>
        <h1 className="mt-1 text-xl font-semibold">AI Usage Monitor</h1>
        <p className="mt-2 text-sm leading-5 text-slate-400">
          Codex usage is live. Claude integration arrives in a later step.
        </p>
      </header>

      <section className="mt-6" aria-live="polite">
        {loadState.status === "loading" && (
          <p className="text-sm text-slate-400">Reading provider state…</p>
        )}
        {loadState.status === "error" && (
          <p className="text-sm text-red-300">{loadState.message}</p>
        )}
        {loadState.status === "ready" && (
          <ul className="space-y-2">
            {loadState.snapshots.map((snapshot) => (
              <li
                className="flex items-center justify-between rounded-lg bg-slate-900 px-3 py-2"
                key={snapshot.providerId}
              >
                <span className="text-sm font-medium capitalize">
                  {snapshot.providerId}
                </span>
                <span className="text-xs text-slate-400">
                  {snapshot.connectionState}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <button
        className="mt-6 min-h-11 w-full rounded-lg bg-blue-600 px-4 text-sm font-semibold hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 disabled:cursor-wait disabled:opacity-60"
        disabled={refreshing}
        onClick={() => void refresh()}
        type="button"
      >
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </main>
  );
}
