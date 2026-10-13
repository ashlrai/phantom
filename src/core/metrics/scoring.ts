/** PR significance/quality scoring, value attribution and allocation. */
import type { PrRef, TelemetryEvent } from './telemetry.js';

/**
 * 0..10, upside-weighted: bigger, bolder, user-facing and core changes score
 * higher. Size and risk are never penalties (high risk tolerance).
 */
export function significance(pr: PrRef): number {
  const size = Math.log10(1 + (pr.additions ?? 0) + (pr.deletions ?? 0)) * 1.4; // grows without a penalty cap
  const bold = pr.risk === 'high' ? 2 : pr.risk === 'medium' ? 1 : 0.3;
  const user = pr.userFacing ? 2.5 : 0.5;
  const area = (pr.areas ?? []).some((a) => /security|auth|secrets|release|billing|core|infra/i.test(a)) ? 1.5 : 0.5;
  return Math.round(Math.min(10, size + bold + user + area) * 100) / 100;
}

/**
 * 0..1. Lightweight and non-blocking: only real regressions lower it
 * (follow-up fixes, reverts). CI retries and review comments are normal
 * iteration and are not penalized; first-try green and coverage gains add a
 * small bonus. Ratings (async, sampled) blend in when present.
 */
export function quality(pr: PrRef, ratings: number[] = [], reverted = false): number {
  if (reverted) return 0;
  let q = 0.75;
  if (pr.ciPassedFirstTry === true) q += 0.1;
  q -= Math.min(0.5, (pr.followUpFixes ?? 0) * 0.15);
  q += Math.max(0, Math.min(0.1, (pr.coverageDelta ?? 0) / 20));
  q = Math.max(0, Math.min(1, q));
  if (ratings.length) q = 0.7 * q + 0.3 * ((ratings.reduce((a, b) => a + b, 0) / ratings.length - 1) / 4);
  return Math.round(q * 1000) / 1000;
}

export interface ArmStats { key: string; sessions: number; successes: number; prsShipped: number; value: number; tokens: number; wallMs: number; costUsd: number; valuePerMTok: number; valuePerHour: number; valuePerUsd: number | null; avgQuality: number | null }
export interface Rollup { totals: ArmStats; byAgent: ArmStats[]; byModel: ArmStats[]; byStrategy: ArmStats[]; byDay: { day: string; prs: number; value: number; tokens: number; costUsd: number }[]; prs: { repo: string; number: number; significance: number; quality: number; value: number; agent: string; strategy?: string }[] }

const prKey = (p: PrRef) => `${p.repo}#${p.number}`;

/** Value = significance × quality, credited to the session that merged a PR shipped to production. */
export function rollup(events: TelemetryEvent[]): Rollup {
  const sess = new Map<string, { agent: string; model?: string; strategy?: string; tokens: number; wallMs: number; cost: number; success: boolean; value: number; prs: number; q: number[] }>();
  const s = (e: TelemetryEvent) => { let x = sess.get(e.sessionId); if (!x) { x = { agent: e.agent, model: e.model, strategy: e.strategy, tokens: 0, wallMs: 0, cost: 0, success: false, value: 0, prs: 0, q: [] }; sess.set(e.sessionId, x); } x.model ??= e.model; x.strategy ??= e.strategy; return x; };
  const ratings = new Map<string, number[]>(); const reverted = new Set<string>();
  for (const e of events) { if (e.kind === 'pr.rated') ratings.set(prKey(e.pr), [...(ratings.get(prKey(e.pr)) ?? []), e.rating]); if (e.kind === 'pr.reverted') reverted.add(prKey(e.pr)); }
  const prs: Rollup['prs'] = []; const days = new Map<string, Rollup['byDay'][number]>();
  const day = (ts: string) => { const d = ts.slice(0, 10); let x = days.get(d); if (!x) { x = { day: d, prs: 0, value: 0, tokens: 0, costUsd: 0 }; days.set(d, x); } return x; };
  for (const e of events) {
    const x = s(e);
    if (e.kind === 'usage') { const t = e.inputTokens + e.outputTokens; x.tokens += t; x.cost += e.costUsd ?? 0; x.wallMs += e.wallMs ?? 0; day(e.ts).tokens += t; day(e.ts).costUsd += e.costUsd ?? 0; }
    if (e.kind === 'session.ended') { x.wallMs = Math.max(x.wallMs, e.wallMs); x.success = e.outcome === 'success'; }
    if (e.kind === 'pr.merged' && e.pr.deployedToProduction !== false) {
      const sig = significance(e.pr); const q = quality(e.pr, ratings.get(prKey(e.pr)), reverted.has(prKey(e.pr)));
      const value = Math.round(sig * q * 100) / 100;
      x.value += value; x.prs++; x.q.push(q); day(e.ts).prs++; day(e.ts).value += value;
      prs.push({ repo: e.pr.repo, number: e.pr.number, significance: sig, quality: q, value, agent: e.agent, ...(e.strategy ? { strategy: e.strategy } : {}) });
    }
  }
  const group = (keyOf: (v: typeof sess extends Map<string, infer V> ? V : never) => string | undefined): ArmStats[] => {
    const m = new Map<string, ArmStats & { qs: number[] }>();
    for (const v of sess.values()) {
      const k = keyOf(v) ?? 'unknown';
      const a = m.get(k) ?? { key: k, sessions: 0, successes: 0, prsShipped: 0, value: 0, tokens: 0, wallMs: 0, costUsd: 0, valuePerMTok: 0, valuePerHour: 0, valuePerUsd: null, avgQuality: null, qs: [] };
      a.sessions++; a.successes += v.success || v.prs > 0 ? 1 : 0; a.prsShipped += v.prs; a.value += v.value; a.tokens += v.tokens; a.wallMs += v.wallMs; a.costUsd += v.cost; a.qs.push(...v.q);
      m.set(k, a);
    }
    return [...m.values()].map(({ qs, ...a }) => ({ ...a, value: Math.round(a.value * 100) / 100, valuePerMTok: a.tokens ? Math.round((a.value / a.tokens) * 1e6 * 100) / 100 : 0, valuePerHour: a.wallMs ? Math.round((a.value / (a.wallMs / 3.6e6)) * 100) / 100 : 0, valuePerUsd: a.costUsd ? Math.round((a.value / a.costUsd) * 100) / 100 : null, avgQuality: qs.length ? Math.round((qs.reduce((p, c) => p + c, 0) / qs.length) * 1000) / 1000 : null })).sort((a, b) => b.valuePerMTok - a.valuePerMTok);
  };
  const empty: ArmStats = { key: 'all', sessions: 0, successes: 0, prsShipped: 0, value: 0, tokens: 0, wallMs: 0, costUsd: 0, valuePerMTok: 0, valuePerHour: 0, valuePerUsd: null, avgQuality: null };
  return { totals: group(() => 'all')[0] ?? empty, byAgent: group((v) => v.agent), byModel: group((v) => v.model), byStrategy: group((v) => v.strategy), byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), prs };
}

/**
 * UCB1 allocator: per task type, recommend the arm (agent|strategy) with the
 * best upper confidence bound on value per million tokens. Unseen arms first.
 */
export function recommend(events: TelemetryEvent[], taskType: string, arms: string[]): { arm: string; reason: string; scores: Record<string, number> } {
  const scoped = events.filter((e) => e.taskType === taskType);
  const sessionsOfArm = (arm: string) => scoped.filter((e) => `${e.agent}|${e.strategy ?? 'default'}` === arm || e.agent === arm);
  const stats = arms.map((arm) => { const r = rollup(sessionsOfArm(arm)); return { arm, n: r.totals.sessions, mean: r.totals.valuePerMTok }; });
  const N = stats.reduce((a, b) => a + b.n, 0);
  const unseen = stats.find((x) => x.n === 0);
  const maxMean = Math.max(1, ...stats.map((x) => x.mean));
  const scores = Object.fromEntries(stats.map((x) => [x.arm, x.n ? Math.round((x.mean / maxMean + Math.sqrt((2 * Math.log(Math.max(N, 1))) / x.n)) * 1000) / 1000 : Infinity]));
  if (unseen) return { arm: unseen.arm, reason: 'explore: no evidence yet for this arm', scores };
  const best = stats.reduce((a, b) => (scores[b.arm]! > scores[a.arm]! ? b : a));
  return { arm: best.arm, reason: `UCB1 over value per 1M tokens (n=${best.n}, mean=${best.mean})`, scores };
}
