export const panelTokens = {
  shell:
    "flex h-[420px] w-[340px] flex-col overflow-hidden border border-stone-700/80 bg-[#11100e] font-sans text-stone-100 antialiased",
  header:
    "flex h-11 shrink-0 items-center gap-2.5 border-b border-stone-800/90 px-3",
  headerMark:
    "grid size-7 shrink-0 place-items-center rounded-md border border-amber-400/25 bg-amber-400/10 text-amber-300",
  headerMarkIcon: "size-3.5",
  headerText: "min-w-0 flex-1",
  title:
    "truncate font-mono text-[13px] font-bold leading-4 tracking-[0.16em] text-stone-50",
  subtitle:
    "mt-0.5 font-mono text-[10px] uppercase leading-3 tracking-[0.08em] text-stone-400",
  headerStatus:
    "shrink-0 font-mono text-[10px] uppercase leading-3 tracking-[0.06em] text-stone-400",
  content:
    "min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 py-1.5 [scrollbar-color:#57534e_transparent] [scrollbar-width:thin]",
  footer:
    "flex h-11 shrink-0 items-center gap-2 border-t border-stone-800/90 bg-[#11100e] px-2",
} as const;

export const summaryTokens = {
  card:
    "rounded-lg border border-stone-700/80 bg-gradient-to-br from-stone-900 to-[#17140f] px-2.5 py-2",
  criticalCard:
    "rounded-lg border border-rose-500/35 bg-gradient-to-br from-rose-950/45 to-[#17100f] px-2.5 py-2",
  warningCard:
    "rounded-lg border border-amber-500/35 bg-gradient-to-br from-amber-950/35 to-[#17140f] px-2.5 py-2",
  staleCard:
    "rounded-lg border border-stone-600/70 bg-stone-900/80 px-2.5 py-2",
  errorCard:
    "rounded-lg border border-rose-500/30 bg-rose-950/25 px-2.5 py-2",
  top: "flex items-center justify-between gap-2",
  eyebrow:
    "font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-stone-500",
  metric: "mt-0.5 flex items-baseline gap-2",
  value:
    "font-mono text-[26px] font-bold leading-7 tabular-nums tracking-tight text-stone-50",
  valueWarning:
    "font-mono text-[26px] font-bold leading-7 tabular-nums tracking-tight text-amber-300",
  valueCritical:
    "font-mono text-[26px] font-bold leading-7 tabular-nums tracking-tight text-rose-300",
  valueStale:
    "font-mono text-[26px] font-bold leading-7 tabular-nums tracking-tight text-stone-500",
  label: "text-[11px] leading-3 text-stone-300",
  detail:
    "mt-0.5 truncate font-mono text-[10px] leading-3 tabular-nums text-stone-400",
} as const;

export const providerTokens = {
  card:
    "rounded-lg border border-stone-800 bg-stone-900/65 px-2.5 py-1.5",
  header: "mb-1 flex items-center justify-between gap-2",
  identity: "flex min-w-0 items-center gap-2",
  name:
    "truncate font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-stone-200",
  status: "flex shrink-0 items-center gap-1.5",
  age:
    "shrink-0 font-mono text-[10px] leading-3 tabular-nums text-stone-400",
  codexMark:
    "grid size-5 shrink-0 place-items-center rounded border border-stone-600 bg-stone-800 text-[9px] font-bold text-stone-200",
  claudeMark:
    "grid size-5 shrink-0 place-items-center rounded border border-amber-500/30 bg-amber-500/10 text-[9px] font-bold text-amber-300",
  gaugeStack: "grid grid-cols-2 gap-1",
} as const;

export const gaugeTokens = {
  row: "rounded-md bg-black/20 px-2 py-1",
  heading: "flex items-baseline justify-between gap-2",
  label:
    "font-mono text-[10px] font-semibold uppercase leading-3 tracking-[0.06em] text-stone-400",
  remainingHealthy:
    "font-mono text-lg font-bold leading-5 tabular-nums tracking-tight text-stone-100",
  remainingWarning:
    "font-mono text-lg font-bold leading-5 tabular-nums tracking-tight text-amber-300",
  remainingCritical:
    "font-mono text-lg font-bold leading-5 tabular-nums tracking-tight text-rose-300",
  remainingStale:
    "font-mono text-lg font-semibold leading-5 tabular-nums tracking-tight text-stone-500",
  track: "mt-0.5 h-1 overflow-hidden rounded-full bg-stone-800",
  fillHealthy:
    "h-full rounded-full bg-stone-400 transition-[width] duration-300 motion-reduce:transition-none",
  fillWarning:
    "h-full rounded-full bg-amber-400 transition-[width] duration-300 motion-reduce:transition-none",
  fillCritical:
    "h-full rounded-full bg-rose-500 transition-[width] duration-300 motion-reduce:transition-none",
  fillStale:
    "h-full rounded-full bg-stone-600 transition-[width] duration-300 motion-reduce:transition-none",
  meta:
    "mt-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-3 text-stone-400",
  countdown:
    "min-w-0 flex-1 truncate font-mono text-[10px] font-semibold tabular-nums text-stone-400",
  staleHint: "sr-only",
  forecast:
    "mt-0.5 truncate font-mono text-[8px] leading-2.5 tabular-nums text-stone-500",
} as const;

export const stateTokens = {
  card:
    "rounded-lg border border-stone-800 bg-stone-900/65 px-3 py-2",
  errorCard:
    "rounded-lg border border-rose-500/30 bg-rose-950/25 px-3 py-2",
  headingRow: "flex items-center justify-between gap-2",
  heading:
    "font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-stone-200",
  errorHeading:
    "font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-rose-200",
  body: "mt-1 text-[10px] leading-3.5 text-stone-400",
  errorBody: "mt-1 text-[10px] leading-3.5 text-rose-200/70",
  badge:
    "shrink-0 rounded-full border border-stone-700 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase leading-3 tracking-[0.04em] text-stone-300",
  staleBadge:
    "shrink-0 rounded-full border border-stone-600 bg-stone-800 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase leading-3 tracking-[0.04em] text-stone-200",
  actions: "mt-2 flex items-center gap-1.5",
  primaryAction:
    "inline-flex h-7 items-center justify-center rounded-md bg-amber-400 px-2.5 text-[10px] font-semibold text-stone-950 hover:bg-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200 disabled:cursor-wait disabled:opacity-60",
  secondaryAction:
    "inline-flex h-7 items-center justify-center rounded-md border border-stone-700 px-2.5 text-[10px] font-medium text-stone-300 hover:bg-stone-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-400 disabled:cursor-wait disabled:opacity-60",
} as const;

export const controlTokens = {
  refresh:
    "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-amber-400 px-3 text-[11px] font-semibold text-stone-950 hover:bg-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200 disabled:cursor-wait disabled:opacity-60",
  quit:
    "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-stone-700 px-3 text-[11px] font-medium text-stone-300 hover:border-stone-600 hover:bg-stone-800 hover:text-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-400",
  icon: "size-3.5 shrink-0",
  spinner:
    "size-3.5 shrink-0 animate-spin motion-reduce:animate-none",
} as const;

export const statusBadgeTokens = {
  healthy:
    "shrink-0 rounded-full border border-stone-600 bg-stone-800/80 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase leading-3 tracking-[0.04em] text-stone-200",
  warning:
    "shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase leading-3 tracking-[0.04em] text-amber-300",
  critical:
    "shrink-0 rounded-full border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase leading-3 tracking-[0.04em] text-rose-300",
  stale:
    "shrink-0 rounded-full border border-stone-600 bg-stone-800 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase leading-3 tracking-[0.04em] text-stone-300",
  offline:
    "shrink-0 rounded-full border border-amber-700/60 bg-amber-950/30 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase leading-3 tracking-[0.04em] text-amber-300",
  "no-data":
    "shrink-0 rounded-full border border-stone-700 bg-stone-900 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase leading-3 tracking-[0.04em] text-stone-300",
  error:
    "shrink-0 rounded-full border border-rose-500/40 bg-rose-950/30 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase leading-3 tracking-[0.04em] text-rose-300",
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
