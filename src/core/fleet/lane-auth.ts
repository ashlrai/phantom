/**
 * `lanes.auth.v1`: which lane cannot sign in, and the one fix for each. Behind `phm fleet lane-auth`, one digest
 * line and the Asks card (desktop and phone) when a blocked lane has plan left unused.
 *
 * Judged only from two things, never from a credential value:
 *   presence  does the sign-in exist on this machine (a file or Keychain item exists; nothing is opened or read)
 *   outcomes  in the last 24 h, did a job end empty on "auth_failed" / "not logged in" text, and has any job
 *             finished with work since
 *
 *   missing_signin  presence check says there is no sign-in
 *   expired         a sign-in exists (or cannot be checked) but a job in the last 24 h was refused and none worked since
 *   ok              a sign-in exists and no unresolved refusal, or no presence check and a job worked in the window
 *   unknown         no presence check for this lane and no job evidence either way (never guessed as ok)
 *
 * Lanes with no presence check here (claude's Keychain entry, codex's home) are judged on outcomes alone.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { poolLabel } from '../usage/runway.js';

export const LANE_AUTH_SCHEMA = 'lanes.auth.v1';
export const LANE_AUTH_WINDOW_HOURS = 24;
/** A blocked lane raises an Asks card only when at least this many percent of its plan would go unused. */
export const LANE_AUTH_UNUSED_PCT = 25;
export const LANE_AUTH_STATES = ['ok', 'missing_signin', 'expired', 'unknown'] as const;
export type LaneAuthState = typeof LANE_AUTH_STATES[number];
export type Presence = 'present' | 'absent' | 'unknown';

export interface LaneAuthRow {
  lane: string;
  label: string;
  state: LaneAuthState;
  /** The one fix in plain words; null when the lane is ok or unknown. */
  fix: string | null;
  /** Why the state was chosen, in plain words. */
  evidence: string;
  /** Jobs in the window that ended on a sign-in refusal. */
  auth_failures: number;
  last_auth_failure_at: string | null;
  last_work_at: string | null;
  /** Share of the lane's plan projected unused at reset; null when there is no current reading. */
  projected_unused_pct: number | null;
  /** True when the lane is blocked on sign-in and enough plan is going unused to raise an Asks card. */
  needs_mason: boolean;
}
export interface LaneAuthV1 {
  schema: typeof LANE_AUTH_SCHEMA;
  generated_at: string;
  window_hours: number;
  lanes: LaneAuthRow[];
  gaps: string[];
}

export interface LaneFinish { lane: string; at: number; empty: boolean; authFailed: boolean }
export interface LaneAuthInput {
  nowMs: number;
  lanes: ReadonlyArray<{ lane: string; heldReason?: string | null }>;
  presence: Readonly<Record<string, Presence>>;
  finishes: readonly LaneFinish[];
  unusedPct?: Readonly<Record<string, number | null>>;
  gaps?: readonly string[];
}

const SIGN_IN_HELD = /sign[ -]?in|log[ -]?in|logged out|not authenticated|unauthori[sz]ed|auth(?:entication)? (?:expired|required|missing)/i;
/** The fix by lane (devin-flash shares devin's). A lane not listed gets the generic sentence. */
const FIX: Readonly<Record<string, string>> = {
  gemini: 'Run `gemini` once in a terminal to sign in',
  claude: 'Run `phm authority claude-signin` to sign in',
  codex: 'Run `codex login` once in a terminal to sign in',
  devin: 'Run `ashlr devin connect` to add the Devin key',
  'devin-flash': 'Run `ashlr devin connect` to add the Devin key',
};
export const laneAuthFix = (lane: string): string => FIX[lane] ?? `Sign in to ${poolLabel(lane)} once in a terminal, then run \`phm fleet lane-auth\``;
const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/** Pure: one row per lane, blocked lanes first, then by plan going unused. */
export function buildLaneAuth(input: LaneAuthInput): LaneAuthV1 {
  const since = input.nowMs - LANE_AUTH_WINDOW_HOURS * 3_600_000;
  const names = new Set<string>([...input.lanes.map(l => l.lane), ...Object.keys(input.presence), ...input.finishes.map(f => f.lane)]);
  names.delete('unknown');
  const rows: LaneAuthRow[] = [];
  for (const lane of names) {
    const mine = input.finishes.filter(f => f.lane === lane && f.at >= since && f.at <= input.nowMs);
    const failures = mine.filter(f => f.empty && f.authFailed);
    const failAt = failures.reduce<number | null>((m, f) => m === null || f.at > m ? f.at : m, null);
    const workAt = mine.filter(f => !f.empty).reduce<number | null>((m, f) => m === null || f.at > m ? f.at : m, null);
    const held = SIGN_IN_HELD.test(input.lanes.find(l => l.lane === lane)?.heldReason ?? '');
    const refused = held || (failAt !== null && (workAt === null || workAt < failAt));
    const presence = input.presence[lane] ?? 'unknown';
    const label = poolLabel(lane);
    let state: LaneAuthState;
    let evidence: string;
    if (presence === 'absent') { state = 'missing_signin'; evidence = `No ${label} sign-in found on this machine.`; }
    else if (refused) {
      state = 'expired';
      evidence = held && failAt === null ? `${label} is held and its hold says to sign in.`
        : `${failures.length} ${failures.length === 1 ? 'job' : 'jobs'} in the last ${LANE_AUTH_WINDOW_HOURS} h ended on a sign-in refusal and none has worked since.`;
    } else if (presence === 'present') { state = 'ok'; evidence = `${label} sign-in found; no sign-in refusal in the last ${LANE_AUTH_WINDOW_HOURS} h.`; }
    else if (workAt !== null) { state = 'ok'; evidence = `A ${label} job worked in the last ${LANE_AUTH_WINDOW_HOURS} h; no sign-in check exists for this lane.`; }
    else { state = 'unknown'; evidence = `No sign-in check exists for ${label} and no job finished in the last ${LANE_AUTH_WINDOW_HOURS} h.`; }
    const unused = input.unusedPct?.[lane] ?? null;
    const blocked = state === 'missing_signin' || state === 'expired';
    rows.push({
      lane, label, state, fix: blocked ? laneAuthFix(lane) : null, evidence, auth_failures: failures.length,
      last_auth_failure_at: iso(failAt), last_work_at: iso(workAt), projected_unused_pct: unused,
      needs_mason: blocked && unused !== null && unused >= LANE_AUTH_UNUSED_PCT,
    });
  }
  const rank = (r: LaneAuthRow): number => r.state === 'missing_signin' ? 0 : r.state === 'expired' ? 1 : r.state === 'unknown' ? 2 : 3;
  rows.sort((a, b) => rank(a) - rank(b) || (b.projected_unused_pct ?? -1) - (a.projected_unused_pct ?? -1) || (a.lane < b.lane ? -1 : 1));
  return {
    schema: LANE_AUTH_SCHEMA, generated_at: new Date(input.nowMs).toISOString(), window_hours: LANE_AUTH_WINDOW_HOURS, lanes: rows,
    gaps: [...(input.gaps ?? []), 'Sign-ins are checked for presence only; nothing is opened and no credential is read.'],
  };
}

/** `phm fleet lane-auth` text: one line per lane, the fix under every lane that is not ok. */
export function formatLaneAuthText(data: LaneAuthV1): string {
  const lines: string[] = [];
  for (const row of data.lanes) {
    const unused = row.projected_unused_pct === null ? '' : ` (${Math.round(row.projected_unused_pct)}% of its plan would go unused)`;
    lines.push(`${row.lane}: ${row.state}${row.state === 'ok' ? '' : unused}`);
    if (row.state === 'unknown') lines.push(`  ${row.evidence}`);
    if (row.fix) lines.push(`  ${row.fix}.`);
  }
  if (!lines.length) lines.push('No lanes found.');
  return lines.join('\n');
}

/** The digest line: blocked lanes with the one most-wasted first; null when no lane is blocked. */
export function laneAuthDigestLine(data: LaneAuthV1): string | null {
  const blocked = data.lanes.filter(r => r.state === 'missing_signin' || r.state === 'expired');
  if (!blocked.length) return null;
  const top = [...blocked].sort((a, b) => (b.projected_unused_pct ?? -1) - (a.projected_unused_pct ?? -1))[0]!;
  const unused = top.projected_unused_pct === null ? '' : `, ${Math.round(top.projected_unused_pct)}% of its plan unused`;
  const more = blocked.length > 1 ? ` (+${blocked.length - 1} more: phm fleet lane-auth)` : '';
  return `Sign-in: ${top.label} ${top.state === 'expired' ? 'sign-in expired' : 'is not signed in'}${unused}. ${top.fix}.${more}`;
}

export function laneAuthAskRequest(row: LaneAuthRow): string {
  return `${row.fix}. ${row.label} will waste about ${Math.round(row.projected_unused_pct ?? 0)}% of its included usage until you do.`;
}

/**
 * Puts one Asks card (shown on desktop and phone) per blocked lane with plan going unused. Idempotent, and skipped when
 * that lane already has an open ask (for example the pools waste sign-in card). Returns the ids raised or found.
 */
export async function raiseLaneAuthAsks(data: LaneAuthV1, options: { runsDir?: string; now?: () => number } = {}): Promise<string[]> {
  const { raiseAsk, listAsks } = await import('./asks.js');
  const ids: string[] = [];
  for (const row of data.lanes.filter(r => r.needs_mason)) {
    const open = listAsks(options).asks.find(a => (a.kind === 'password' || a.kind === 'signin') && a.subject === row.lane);
    if (open) { ids.push(open.id); continue; }
    const raised = raiseAsk('password', laneAuthAskRequest(row), options, { subject: row.lane, unblocks: `${row.label} usage that would otherwise expire` });
    if (raised.ok) ids.push(raised.id);
  }
  return ids;
}

export interface PresenceProbes {
  exists?: (path: string) => boolean;
  hasEnv?: (name: string) => boolean;
  hasDevinKey?: () => Promise<boolean>;
  home?: string;
}

/**
 * Presence checks, nothing more: a path exists, an environment name is set, a Keychain item exists. No file is opened and
 * no value is read. ~/.codex* is never looked at; codex and claude's Keychain entry have no check and read as unknown.
 */
export async function probePresence(lanes: readonly string[], probes: PresenceProbes = {}): Promise<Record<string, Presence>> {
  const exists = probes.exists ?? existsSync;
  const hasEnv = probes.hasEnv ?? ((name: string) => (process.env[name] ?? '') !== '');
  const home = probes.home ?? homedir();
  const out: Record<string, Presence> = {};
  for (const lane of lanes) {
    if (lane === 'gemini') {
      out[lane] = exists(join(home, '.gemini', 'oauth_creds.json')) || hasEnv('GEMINI_API_KEY') || hasEnv('GOOGLE_API_KEY') ? 'present' : 'absent';
    } else if (lane === 'devin' || lane === 'devin-flash') {
      const has = probes.hasDevinKey ?? (async () => (await import('../devin/secret.js')).hasDevinKey());
      out[lane] = await has().catch(() => false) ? 'present' : 'absent';
    } else if (lane === 'claude') {
      out[lane] = exists(join(home, '.claude', '.credentials.json')) ? 'present' : 'unknown';
    } else out[lane] = 'unknown';
  }
  return out;
}

/** Reads the dispatcher status, the 24 h job ledger and log tails, the pools view and the presence checks. Read-only. */
export async function readLaneAuth(opts: { runsDir?: string; now?: () => number; probes?: PresenceProbes } = {}): Promise<LaneAuthV1> {
  const nowMs = (opts.now ?? Date.now)();
  const root = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const [{ readFleetRunsDirState }, { ledgerRows }, { finishesIn }, { emptyFamilyReason, tail }] = await Promise.all([
    import('./runs-dir-state.js'), import('./empty-cause.js'), import('./empties.js'), import('./empty-families.js'),
  ]);
  const gaps: string[] = [];
  const state = await readFleetRunsDirState({ runsDir: root, now: () => nowMs }).catch(() => null);
  if (!state || state.sources.status !== 'healthy') gaps.push('The dispatcher status could not be read, so lane targets and holds are unknown.');
  // Bounded, no-follow reads like the existing empty-family reader; job ids cannot escape root.
  const ledger = await tail(join(root, 'metrics', 'jobs.jsonl'), 8 * 1024 * 1024);
  const finishes: LaneFinish[] = [];
  if (ledger === null) gaps.push('The job history could not be read, so recent outcomes are unknown.');
  else {
    const done = finishesIn(ledgerRows(ledger, nowMs, LANE_AUTH_WINDOW_HOURS).rows).filter(f => !f.skipped && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(f.id));
    for (let i = 0; i < done.length; i += 16) {
      finishes.push(...await Promise.all(done.slice(i, i + 16).map(async f => {
        if (!f.empty) return { lane: f.lane, at: f.at, empty: false, authFailed: false };
        const [log, publish] = await Promise.all([tail(join(root, `${f.id}.log`), 65536), tail(join(root, `${f.id}.publish`), 65536)]);
        return { lane: f.lane, at: f.at, empty: true, authFailed: emptyFamilyReason(log, publish) === 'auth_failed' };
      })));
    }
  }
  const lanes = (state?.lanes ?? []).map(l => ({ lane: l.lane, heldReason: l.held ? l.heldReason : null }));
  const names = [...new Set([...lanes.map(l => l.lane), ...finishes.map(f => f.lane)])];
  const unusedPct: Record<string, number | null> = {};
  try {
    const [{ readResourceLedger }, { buildPoolsView }, { readUsageSamples }] = await Promise.all([import('./runs-resource-ledger.js'), import('./pools-view.js'), import('./usage-history.js')]);
    // personalCodexHome points at a path that does not exist: this check never looks under ~/.codex*.
    const view = buildPoolsView(await readResourceLedger({ runsDir: root, now: () => nowMs, personalCodexHome: join(root, 'no-codex-home') }), nowMs, await readUsageSamples({ runsDir: root, nowMs }));
    for (const row of view.pools) unusedPct[row.id] = row.projectedUnusedPct;
  } catch { gaps.push('Plan usage could not be read, so no lane is checked for unused plan.'); }
  return buildLaneAuth({ nowMs, lanes, presence: await probePresence(names, opts.probes), finishes, unusedPct, gaps });
}
