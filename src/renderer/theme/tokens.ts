export const panelTokens = {
  shell:
    "flex h-[420px] w-[340px] flex-col overflow-hidden border border-slate-700/80 bg-[#080d18] font-sans text-slate-100 antialiased",
  header:
    "flex h-12 shrink-0 items-center gap-2.5 border-b border-slate-800 px-3",
  headerMark:
    "grid size-7 shrink-0 place-items-center rounded-lg border border-sky-400/20 bg-sky-400/10 text-sky-300",
  headerMarkIcon: "size-4",
  headerText: "min-w-0",
  title: "truncate text-sm font-semibold leading-4 text-slate-50",
  subtitle: "mt-0.5 text-[11px] leading-3 text-slate-500",
  content:
    "min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-2 [scrollbar-color:#334155_transparent] [scrollbar-width:thin]",
  footer:
    "flex h-12 shrink-0 items-center gap-2 border-t border-slate-800 bg-[#080d18] px-2",
} as const;

export const providerTokens = {
  card: "rounded-xl border border-slate-800 bg-slate-900/70 px-2.5 py-2",
  header: "mb-1.5 flex items-center justify-between gap-2",
  identity: "flex min-w-0 items-center gap-2",
  name: "truncate text-xs font-semibold text-slate-100",
  age: "shrink-0 text-[10px] tabular-nums text-slate-500",
  codexMark:
    "grid size-5 shrink-0 place-items-center rounded-md bg-sky-400/10 text-[10px] font-bold text-sky-300",
  claudeMark:
    "grid size-5 shrink-0 place-items-center rounded-md bg-orange-400/10 text-[10px] font-bold text-orange-300",
  gaugeStack: "space-y-1.5",
} as const;

export const gaugeTokens = {
  row: "rounded-lg bg-slate-950/50 px-2 py-1.5",
  heading: "flex items-baseline justify-between gap-2",
  label: "text-[11px] font-medium leading-4 text-slate-300",
  remainingHealthy:
    "text-sm font-bold leading-4 tabular-nums text-sky-300",
  remainingWarning:
    "text-sm font-bold leading-4 tabular-nums text-amber-300",
  remainingCritical:
    "text-sm font-bold leading-4 tabular-nums text-rose-300",
  remainingStale:
    "text-sm font-semibold leading-4 tabular-nums text-slate-400",
  track: "mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800",
  fillHealthy:
    "h-full rounded-full bg-sky-400 transition-[width] duration-300 motion-reduce:transition-none",
  fillWarning:
    "h-full rounded-full bg-amber-400 transition-[width] duration-300 motion-reduce:transition-none",
  fillCritical:
    "h-full rounded-full bg-rose-500 transition-[width] duration-300 motion-reduce:transition-none",
  fillStale:
    "h-full rounded-full bg-slate-600 transition-[width] duration-300 motion-reduce:transition-none",
  meta:
    "mt-1 flex items-center justify-between gap-2 text-[10px] leading-3 text-slate-500",
  countdown: "tabular-nums",
  staleHint: "truncate text-slate-500",
} as const;

export const stateTokens = {
  card: "rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2.5",
  errorCard:
    "rounded-xl border border-rose-400/20 bg-rose-400/[0.04] px-3 py-2.5",
  headingRow: "flex items-center justify-between gap-2",
  heading: "text-xs font-semibold text-slate-200",
  errorHeading: "text-xs font-semibold text-rose-200",
  body: "mt-1 text-[11px] leading-4 text-slate-500",
  errorBody: "mt-1 text-[11px] leading-4 text-rose-200/70",
  badge:
    "shrink-0 rounded-full border border-slate-700 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400",
  staleBadge:
    "shrink-0 rounded-full border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-300",
} as const;

export const controlTokens = {
  refresh:
    "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-sky-500 px-3 text-xs font-semibold text-slate-950 hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 disabled:cursor-wait disabled:opacity-60",
  quit:
    "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-slate-700 px-3 text-xs font-medium text-slate-300 hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400",
  icon: "size-3.5 shrink-0",
  spinner:
    "size-3.5 shrink-0 animate-spin motion-reduce:animate-none",
} as const;

export const severityTokens = {
  healthy: {
    remaining: gaugeTokens.remainingHealthy,
    fill: gaugeTokens.fillHealthy,
  },
  warning: {
    remaining: gaugeTokens.remainingWarning,
    fill: gaugeTokens.fillWarning,
  },
  critical: {
    remaining: gaugeTokens.remainingCritical,
    fill: gaugeTokens.fillCritical,
  },
  stale: {
    remaining: gaugeTokens.remainingStale,
    fill: gaugeTokens.fillStale,
  },
} as const;
