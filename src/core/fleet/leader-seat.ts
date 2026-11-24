/** Read-only leader placement. Reuses the dispatcher and Models readers; never probes a provider. */
import type { FleetRunsDirState } from './runs-dir-state.js';
import { laneModelFamily, resolveLaneModel, type LaneModelSnapshot } from './lane-models.js';
import { selectVerifiedModel, type VerifiedModelRegistryEntry } from './model-verify.js';
import { QUOTA_EVIDENCE_MAX_AGE_MS } from './resource-reset-evidence.js';

export interface LeaderLaneSeat {
  lane: string; model: string|null; confirmed: boolean;
  /** The leader CLI for this lane (`claude`, `codex`, `gemini`); null when no leader command is known. */
  cli: string|null;
  health: 'ok'|'degraded'|'down'|'unknown';
  headroomPct: number|null; resetAt: string|null; recentPassMs: number|null;
  /** Newest rate limit or failed pass in the last hour; null when none is recorded. */
  rateLimitedAt: string|null;
  eligible: boolean; reason: string|null;
}
export interface LeaderSeatReport {
  schema: 'leader.seat.v1'; version: 1; generatedAt: string;
  current: { lane: string|null; model: string|null; lastSuccessAt: string|null;
    /** Plan usage and reset of the current lane; null = unknown. */
    used_pct?: number|null; reset_at?: string|null };
  /** True when the current seat can keep the leader; false when it cannot; null when unknown. */
  healthy?: boolean|null;
  /** Other lanes that can take the leader, soonest reset first. Lanes that are drained, held, down or have no usage reading are left out. */
  fallback?: LeaderFallback[];
  /** Plain reason `fallback` is empty ("No other plan has usage left."); null otherwise. */
  fallback_reason?: string|null;
  fallbacks: LeaderLaneSeat[]; pick: LeaderLaneSeat|null;
  /** The seat the leader moves to if the pick fails. */
  next?: LeaderLaneSeat|null;
  /** The current lane's own assessment (why it stays or loses the seat); null when the current lane is unknown. */
  currentSeat?: LeaderLaneSeat|null;
  reason: string|null;
}
export interface LeaderFallback { lane: string; model: string|null; used_pct: number; reset_at: string|null; why: string }
/** One recent failure on a lane. `rate-limit` is a provider limit; `failed` is a failed leader pass. */
export interface LeaderSeatFailure { lane: string; at: string; kind: 'rate-limit'|'failed' }
/** The compact answer agents adopt: where the leader runs, or plainly why it cannot. */
export type LeaderSeatChoice =
  | { ok: true; pool: string; model: string; cli: string; reason: string; next: { pool: string; model: string; cli: string }|null }
  | { ok: false; pool: null; model: null; cli: null; reason: string; next: null };

export const LEADER_FAILURE_WINDOW_MS = 3_600_000;
/** Headless leader commands; the prompt always arrives on stdin, never on argv. */
const LEADER_COMMANDS: Record<string, (model: string) => string[]> = {
  claude: model => ['claude', '-p', '--model', model],
  codex: model => ['codex', 'exec', '--model', model, '-'],
  gemini: model => ['gemini', '--model', model],
};
/** The leader CLI for a lane's family, or null. Own keys only, so `constructor` never resolves. */
const leaderCli = (lane: string): string|null => Object.hasOwn(LEADER_COMMANDS, laneModelFamily(lane)) ? laneModelFamily(lane) : null;
const healthRank = { ok: 0, degraded: 1, down: 2, unknown: 3 };
/** Lexicographic score: health, descending included headroom, ascending recent pass ms, lane ID.
 * Unknown numbers sort last. No provider preference or clock/I/O inside the comparator. */
export function compareLeaderSeats(a: LeaderLaneSeat, b: LeaderLaneSeat): number {
  return healthRank[a.health] - healthRank[b.health] || (b.headroomPct ?? -1) - (a.headroomPct ?? -1)
    || (a.recentPassMs ?? Number.MAX_VALUE) - (b.recentPassMs ?? Number.MAX_VALUE)
    || (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0);
}
export function buildLeaderSeat(runs: FleetRunsDirState|null, models: LaneModelSnapshot|null,
  registry: readonly VerifiedModelRegistryEntry[]|null, now: number, failures: readonly LeaderSeatFailure[] = []): LeaderSeatReport {
  const fresh = (at: string|null|undefined, max: number) => !!at && now >= Date.parse(at) && now - Date.parse(at) <= max;
  const statusFresh = runs?.sources.status === 'healthy' && fresh(runs.lastTick, QUOTA_EVIDENCE_MAX_AGE_MS);
  const choices = new Map(models?.lanes.flatMap(row => (row.tiers ?? []).flatMap(tier => tier.model ? [[`${row.lane}.${tier.tier}`, tier.model] as const] : [])));
  const recent = [...failures, ...(runs?.lanes ?? []).flatMap(({ lane, seat }): LeaderSeatFailure[] => [
    ...(seat?.rateLimitedAt ? [{ lane, at: seat.rateLimitedAt, kind: 'rate-limit' as const }] : []),
    ...(seat?.failedAt ? [{ lane, at: seat.failedAt, kind: 'failed' as const }] : [])])]
    .filter(f => fresh(f.at, LEADER_FAILURE_WINDOW_MS)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const seats = (runs?.lanes ?? []).map((lane): LeaderLaneSeat => {
    const data = lane.seat, model = resolveLaneModel(choices, lane.lane, 'frontier')?.model ?? null;
    const confirmed = model !== null && selectVerifiedModel([model], registry ?? []).model === model;
    const cli = leaderCli(lane.lane);
    const failure = recent.find(f => f.lane === lane.lane) ?? null;
    const health = statusFresh ? data?.health ?? (lane.healthy === true ? 'ok' : lane.healthy === false ? 'down' : 'unknown') : 'unknown';
    const quotaFresh = statusFresh && fresh(data?.observedAt, QUOTA_EVIDENCE_MAX_AGE_MS) && !!data?.resetAt && Date.parse(data.resetAt) > now;
    const headroomPct = quotaFresh && data?.usedPct != null && Number.isFinite(data.usedPct) && data.usedPct >= 0 ? Math.max(0, 100 - data.usedPct) : null;
    const recentPassMs = statusFresh && fresh(data?.passAt, 12 * 3_600_000) ? data?.passMs ?? null : null;
    const reason = !confirmed ? 'Model is not confirmed in the registry.' : runs?.paused ? 'Dispatch is paused.'
      : lane.held ? 'Lane is held.' : health === 'unknown' ? 'Lane health is unknown.' : health === 'down' ? 'Lane is down.'
      : headroomPct === 0 ? 'Included usage is exhausted.'
      : failure ? (failure.kind === 'rate-limit' ? 'Rate-limited in the last hour.' : 'A leader pass failed here in the last hour.')
      : cli === null ? 'No leader command is known for this lane.' : null;
    return { lane: lane.lane, model, confirmed, cli, health, headroomPct, resetAt: data?.resetAt ?? null,
      recentPassMs, rateLimitedAt: failure?.at ?? null, eligible: reason === null, reason };
  }).sort(compareLeaderSeats);
  const current = { lane: statusFresh ? runs?.leader?.lane ?? null : null, model: statusFresh ? runs?.leader?.model ?? null : null,
    lastSuccessAt: runs?.leader?.lastSuccessAt ?? null };
  const [pick = null, next = null] = seats.filter(seat => seat.eligible);
  const currentSeat = seats.find(seat => seat.lane === current.lane) ?? null;
  const resetMs = (at: string|null) => at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : Number.MAX_VALUE;
  const fallback = seats.filter(seat => seat.lane !== current.lane && seat.eligible && seat.headroomPct !== null)
    .sort((a, b) => resetMs(a.resetAt) - resetMs(b.resetAt) || compareLeaderSeats(a, b))
    .map((seat): LeaderFallback => ({ lane: seat.lane, model: seat.model, used_pct: 100 - seat.headroomPct!, reset_at: seat.resetAt,
      why: `${seat.headroomPct}% of included usage left${seat.resetAt ? `, resets ${seat.resetAt}` : ''}.` }));
  const healthy = currentSeat ? currentSeat.eligible : null;
  return { schema: 'leader.seat.v1', version: 1, generatedAt: new Date(now).toISOString(),
    current: { ...current, used_pct: currentSeat?.headroomPct == null ? null : 100 - currentSeat.headroomPct, reset_at: currentSeat?.headroomPct == null ? null : currentSeat.resetAt },
    healthy, fallback, fallback_reason: fallback.length ? null : 'No other plan has usage left.',
    fallbacks: seats.filter(seat => seat.lane !== current.lane), pick, next,
    currentSeat,
    reason: pick ? null : seats.every(seat => seat.health === 'unknown') ? 'No seat: lane health is unknown.'
      : `No seat available. ${seats.map(seat => `${seat.lane}: ${seat.reason}`).join(' ')}` };
}
/** Pure reduction of a report to `{pool, model, cli, reason}`; only eligible seats (confirmed model, known CLI) can appear. */
export function pickSeat(report: LeaderSeatReport): LeaderSeatChoice {
  const seat = (s: LeaderLaneSeat|null|undefined) => s?.eligible && s.model && s.cli ? { pool: s.lane, model: s.model, cli: s.cli } : null;
  const pick = seat(report.pick);
  if (!pick) return { ok: false, pool: null, model: null, cli: null, reason: report.reason ?? 'No seat available.', next: null };
  const left = report.pick!.headroomPct === null ? 'runway unknown' : `${report.pick!.headroomPct}% of included usage left`;
  return { ok: true, ...pick, reason: `Lane ${report.pick!.health}, confirmed model, not rate-limited in the last hour; ${left}.`, next: seat(report.next) };
}
/** The exact headless command for a seat. The prompt file is redirected to stdin; no env values are ever included. */
export function leaderSeatCommand(seat: { cli: string; model: string }, promptFile: string): { argv: string[]; stdin: string; text: string } {
  const family = leaderCli(seat.cli);
  if (family === null || family !== seat.cli) throw new Error('No leader command is known for this seat.');
  // Same shape lane-models accepts; a leading `-` could never be read as a flag.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(seat.model)) throw new Error('The seat model is not a plain model ID.');
  const argv = LEADER_COMMANDS[family]!(seat.model);
  const quote = (word: string) => /^[A-Za-z0-9._:/+@%-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
  return { argv, stdin: promptFile, text: `${argv.map(quote).join(' ')} < ${quote(promptFile)}` };
}
/** `claude-opus-5-5` → `Opus 5.5`, `gpt-6.1-sol` → `GPT-6.1 Sol`; unknown shapes keep their words. */
export function seatModelName(model: string): string {
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(model);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}.${claude[3]}`;
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(model);
  const words = (rest: string) => rest.split('-').filter(Boolean).map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ') || rest;
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${words(gpt[2])}` : ''}`;
  return words(model);
}
const poolName = (lane: string) => { const family = laneModelFamily(lane); return family[0]!.toUpperCase() + family.slice(1); };
/** One plain line for the Leader card and CLI: `Leader: Opus 5.5 on Claude, next: GPT-6.1 Sol on Codex`. */
export function leaderSeatLine(report: LeaderSeatReport): string {
  const choice = pickSeat(report);
  if (!choice.ok) {
    const why = choice.reason.replace(/^No seat(?: available)?[:.]\s*/, '');
    return `Leader: no seat available. ${why.charAt(0).toUpperCase()}${why.slice(1)}`;
  }
  const on = (s: { pool: string; model: string }) => `${seatModelName(s.model)} on ${poolName(s.pool)}`;
  return `Leader: ${on(choice)}, next: ${choice.next ? on(choice.next) : 'none'}`;
}
export interface LeaderSeatReaders {
  status: () => Promise<FleetRunsDirState|null>;
  models: () => Promise<LaneModelSnapshot|null>;
  registry: () => Promise<VerifiedModelRegistryEntry[]|null>;
  /** Recent rate limits and failed passes beyond what the dispatcher status records. */
  failures: () => Promise<LeaderSeatFailure[]>;
  now: () => number;
}
export async function readLeaderSeat(readers: Partial<LeaderSeatReaders> = {}): Promise<LeaderSeatReport> {
  const now = (readers.now ?? Date.now)();
  const status = readers.status ?? (async () => (await import('./runs-dir-state.js')).readFleetRunsDirState({ now: () => now }));
  const models = readers.models ?? (async () => (await import('./lane-models.js')).getLaneModelSnapshot());
  const registry = readers.registry ?? (async () => (await import('./model-verify.js')).loadVerifiedRegistry({ now: () => now }));
  const [s, m, r, f] = await Promise.allSettled([status(), models(), registry(), (readers.failures ?? (async () => []))()]);
  return buildLeaderSeat(s.status === 'fulfilled' ? s.value : null, m.status === 'fulfilled' ? m.value : null,
    r.status === 'fulfilled' ? r.value : null, now, f.status === 'fulfilled' ? f.value : []);
}
/** What a launcher should use now: the current seat while it is healthy, else the soonest-resetting fallback; null when neither. */
export function launcherSeat(report: LeaderSeatReport): { lane: string; model: string }|null {
  const keep = report.healthy && report.current.lane && report.current.model ? { lane: report.current.lane, model: report.current.model } : null;
  const move = report.fallback?.find(f => f.model);
  return keep ?? (move ? { lane: move.lane, model: move.model! } : null);
}
/** The Org-view "Leader" chip: the current model by plain name, its plan usage, and whether to warn (above 95%). Unknown stays null. */
export interface LeaderChip { model: string|null; lane: string|null; used_pct: number|null; reset_at: string|null; warn: boolean }
export function leaderChip(report: LeaderSeatReport): LeaderChip {
  const used = report.current.used_pct ?? null;
  return { model: report.current.model ? seatModelName(report.current.model) : null, lane: report.current.lane, used_pct: used,
    reset_at: report.current.reset_at ?? null, warn: used !== null && used > 95 };
}
export function leaderSeatText(report: LeaderSeatReport, pickOnly = false): string {
  const line = (seat: LeaderLaneSeat) => `${seat.lane} · ${seat.model ?? 'model unknown'} · ${seat.health} · headroom ${seat.headroomPct === null ? 'unknown' : `${seat.headroomPct}%`}${seat.reason ? ` · ${seat.reason}` : ''}`;
  const next = report.pick ? `Next seat: ${line(report.pick)}` : report.reason!;
  return pickOnly ? next : [leaderSeatLine(report), `Leader seat: ${report.current.lane ?? 'unknown'} · ${report.current.model ?? 'model unknown'}${report.currentSeat?.reason ? ` · ${report.currentSeat.reason}` : ''}`,
    `Last successful pass: ${report.current.lastSuccessAt ?? 'unknown'}`, next, ...report.fallbacks.map(seat => `Fallback: ${line(seat)}`),
    ...(report.healthy === false && report.fallback_reason ? [report.fallback_reason] : [])].join('\n');
}
