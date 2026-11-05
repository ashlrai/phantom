/**
 * core/fleet/friction.ts — the dispatch→merge friction ledger (RQ-FRICTION-2).
 * `phm friction` mines ~/.ashlr-runs read-only — jobs.jsonl finishes, the
 * dispatch event log, ready.tsv rows, guardian red-main state, lane slots and
 * the manual-override files — folds operator annotations kept in
 * friction/ledger.jsonl, and scores each recurring drag as
 *   delegation unlocked × 7d frequency × blast radius / cost.
 * An unread source leaves its signals unknown (null), never zero. Evidence
 * stays runs-dir-relative and secret-scrubbed.
 */
import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { localTimestamp, readSource } from './runs-parked-queue.js';
import { parseGuardianState } from './main-red-age.js';
import { scrubSecrets } from '../util/scrub.js';

export const FRICTION_WINDOW_MS = 7 * 24 * 3_600_000;
/** READY rows older than this without a newer launch are unclaimed, not queued. */
export const FRICTION_STALE_READY_MS = 6 * 3_600_000;
const TIERS = new Set(['frontier', 'work', 'mid', 'fast']);
const QUOTA_ERRORS = new Set(['credits_exhausted', 'usage_limit', 'model_capacity', 'rate_limit']);
const AUTH_RX = /auth|401|token|login|credential|expired|unauthor/i;
const JID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const STATUSES = new Set(['open', 'in-progress', 'fixed', 'wontfix'] as const);
export type FrictionNoteStatus = 'open' | 'in-progress' | 'fixed' | 'wontfix';
export type FrictionStatus = FrictionNoteStatus | 'quiet' | 'regressed';
export type SourceState = 'read' | 'missing' | 'unreadable';

export interface FrictionInput {
  jobs?: string | null;
  events?: string | null;
  ready?: string | null;
  guardian?: string | null;
  slots?: string | null;
  overrides?: string | null;
  keep?: string | null;
  ledger?: string | null;
  now?: number;
  /** Read health per source file; when absent each source reports its text's presence. */
  sourceStates?: Record<string, SourceState>;
}
export interface FrictionItem {
  id: string;
  title: string;
  owner: string;
  status: FrictionStatus;
  /** Named 7d signal counts; null when the source was unreadable. */
  signals: Record<string, number | null>;
  /** The primary signal's metric: first ledger scan vs this run. */
  metric: { unit: string; before: number | null; after: number | null };
  score: number | null;
  evidence: string[];
}
export interface FrictionReport {
  schema: 'phm.friction.v1';
  generatedAt: string;
  windowDays: 7;
  sources: Record<string, SourceState>;
  items: FrictionItem[];
}

interface Knobs { owner: string; unlock: number; blast: number; cost: number; primary: string }
const CATALOG: Record<string, { title: string } & Knobs> = {
  'empty-finishes': { title: 'Worker runs that finish with no diff, a refusal or a nonzero exit', owner: 'fleet', unlock: 3, blast: 3, cost: 2, primary: 'bad' },
  'requeues': { title: 'Launches deferred and jobs requeued instead of running', owner: 'dispatchd', unlock: 3, blast: 2, cost: 2, primary: 'requeued' },
  'lane-auth': { title: 'Lane auth expiries, autobackoff holds and re-logins', owner: 'security', unlock: 3, blast: 2, cost: 3, primary: 'auth_failures' },
  'quota-exhaustion': { title: 'Usage limits, credit exhaustion and model-capacity stalls', owner: 'fleet', unlock: 2, blast: 3, cost: 3, primary: 'usage_limits' },
  'invalid-tier': { title: 'Queue rows and enqueues carrying a tier dispatchd skips', owner: 'queuegen', unlock: 2, blast: 2, cost: 1, primary: 'ready_rows' },
  'red-main': { title: 'Default branches sitting red', owner: 'main-guardian', unlock: 3, blast: 3, cost: 2, primary: 'repos_red' },
  'stale-ready': { title: 'READY rows unclaimed past the stale boundary', owner: 'dispatchd', unlock: 2, blast: 2, cost: 1, primary: 'unclaimed' },
  'manual-interventions': { title: 'Holds and overrides a human placed by hand', owner: 'masbot', unlock: 3, blast: 1, cost: 2, primary: 'manual_holds' },
  'wrong-route': { title: 'Jobs routed to the wrong account or tool and moved back', owner: 'router', unlock: 2, blast: 2, cost: 2, primary: 'route_moves' },
  'holds': { title: 'Lane holds and parked rows blocking the queue', owner: 'fleet', unlock: 2, blast: 3, cost: 2, primary: 'hold_events' },
};

const cut = (s: string, n = 90): string => scrubSecrets(s.replace(/\s+/g, ' ').trim()).slice(0, n);
/** Sum nullable counts; null only when every term is unknown. */
const sum = (vs: (number | null)[]): number | null => vs.every(v => v === null) ? null : vs.reduce((a: number, v) => a + (v ?? 0), 0);

/** jobs.jsonl ts ("%Y-%m-%dT%H:%M:%S%z") and ISO stamps both parse under Date.parse. */
const tsMs = (v: unknown): number => {
  const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(t) ? t : NaN;
};
const z = (text: string | null | undefined): number | null => text == null ? null : 0;

interface JobRow { event: string; job: string | null; lane: string | null; at: number; raw: Record<string, unknown> }
function jobRows(text: string): JobRow[] {
  const rows: JobRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const raw: unknown = JSON.parse(line);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.event !== 'string') continue;
      rows.push({ event: r.event, job: typeof r.job === 'string' && JID.test(r.job) ? r.job : null,
        lane: typeof r.lane === 'string' ? r.lane.slice(0, 64) : null, at: tsMs(r.ts ?? r.at ?? r.timestamp), raw: r });
    } catch { /* malformed ledger line */ }
  }
  return rows;
}

interface EventLine { at: number; text: string }
function eventLines(text: string): EventLine[] {
  const lines: EventLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    lines.push({ at: localTimestamp(m[1]!).ms, text: m[2]! });
  }
  return lines;
}

export interface LedgerFold {
  notes: Map<string, { status: FrictionNoteStatus; owner: string | null; ts: string }>;
  /** item id → count at first and latest scan, oldest first. */
  scans: Map<string, { before: number; beforeTs: string; after: number; afterTs: string }>;
  dropped: number;
}
/** Fold the append-only friction ledger; latest note row wins per item. */
export function foldFrictionLedger(text: string): LedgerFold {
  const notes = new Map<string, { status: FrictionNoteStatus; owner: string | null; ts: string }>();
  const scans = new Map<string, { before: number; beforeTs: string; after: number; afterTs: string }>();
  let dropped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const raw: unknown = JSON.parse(line);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { dropped++; continue; }
      const r = raw as Record<string, unknown>;
      if (r.kind === 'note' && typeof r.item === 'string' && CATALOG[r.item] !== undefined &&
          typeof r.status === 'string' && (STATUSES as ReadonlySet<string>).has(r.status) &&
          // eslint-disable-next-line no-control-regex -- owner text must not carry control bytes.
          (r.owner === undefined || (typeof r.owner === 'string' && r.owner.length <= 64 && !/[\u0000-\u001f\u007f/\\]/.test(r.owner)))) {
        notes.set(r.item, { status: r.status as FrictionNoteStatus, owner: typeof r.owner === 'string' ? r.owner : null,
          ts: typeof r.ts === 'string' ? r.ts : '' });
      } else if (r.kind === 'scan' && typeof r.ts === 'string' && r.items && typeof r.items === 'object' && !Array.isArray(r.items)) {
        for (const [id, n] of Object.entries(r.items as Record<string, unknown>)) {
          if (CATALOG[id] === undefined || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) continue;
          const slot = scans.get(id);
          if (slot) { slot.after = n; slot.afterTs = r.ts; }
          else scans.set(id, { before: n, beforeTs: r.ts, after: n, afterTs: r.ts });
        }
      } else dropped++;
    } catch { dropped++; }
  }
  return { notes, scans, dropped };
}

/** The scan row this report would append — null when counts are unchanged or nothing measured. */
export function frictionScanRow(report: FrictionReport, ledger: LedgerFold, now: number): string | null {
  const items: Record<string, number> = {};
  for (const item of report.items) {
    const n = item.signals[CATALOG[item.id]!.primary];
    if (typeof n === 'number') items[item.id] = n;
  }
  if (Object.keys(items).length === 0) return null;
  const unchanged = ledger.scans.size > 0 && Object.keys(items).length === ledger.scans.size &&
    [...ledger.scans.entries()].every(([id, s]) => items[id] === s.after);
  return unchanged ? null
    : JSON.stringify({ kind: 'scan', v: 1, ts: new Date(now).toISOString(), items });
}

/** A validated note row, or null when the item/status/owner is not allowed. */
export function frictionNoteRow(itemId: string, status: string, owner: string | undefined, now: number): string | null {
  if (CATALOG[itemId] === undefined || !(STATUSES as ReadonlySet<string>).has(status)) return null;
  // eslint-disable-next-line no-control-regex -- owner text must not carry control bytes.
  if (owner !== undefined && (!owner.length || owner.length > 64 || /[\u0000-\u001f\u007f/\\]/.test(owner))) return null;
  return JSON.stringify({ kind: 'note', v: 1, ts: new Date(now).toISOString(), item: itemId, status, ...(owner ? { owner } : {}) });
}

export function mineFriction(input: FrictionInput): FrictionReport {
  const now = input.now ?? Date.now();
  const floor = now - FRICTION_WINDOW_MS;
  const jobs = input.jobs == null ? null : jobRows(input.jobs);
  const events = input.events == null ? null : eventLines(input.events);
  const in7d = (at: number) => Number.isFinite(at) && at >= floor && at <= now + 60_000;
  const evidence: Record<string, string[]> = Object.fromEntries(Object.keys(CATALOG).map(id => [id, []]));
  const ev = (id: string, text: string) => { const list = evidence[id]!; if (list.length < 3 && !list.includes(text)) list.push(cut(text)); };

  // ── jobs.jsonl: finishes, backoff holds, enqueues, launches ──────────────
  const zero = z(input.jobs);
  let empty = zero, refused = zero, failed = zero, authHolds = zero, quotaSkips = zero, authSkips = zero;
  let badTierEnqueue = zero, precheckParks = zero, quotaHoldJobs = zero, quotaFinish = zero;
  const enqueued = new Map<string, number>(); const launched = new Map<string, number>();
  const laneAuthHold = new Map<string, number>(); const laneFinish = new Map<string, number>();
  for (const r of jobs ?? []) {
    // Rows older than 7d still feed the ready-join maps below.
    if (r.event === 'enqueue' && r.job && Number.isFinite(r.at)) enqueued.set(r.job, Math.max(enqueued.get(r.job) ?? -1, r.at));
    if ((r.event === 'launch' || r.event === 'claim') && r.job && Number.isFinite(r.at)) launched.set(r.job, Math.max(launched.get(r.job) ?? -1, r.at));
    if (!in7d(r.at)) continue;
    if (r.event === 'enqueue' && typeof r.raw.tier === 'string' && r.raw.tier && !TIERS.has(r.raw.tier)) {
      badTierEnqueue = (badTierEnqueue ?? 0) + 1; if (r.job) ev('invalid-tier', `jobs.jsonl enqueue job=${r.job} tier=${r.raw.tier}`);
    }
    if (r.event === 'finish') {
      const isEmpty = r.raw.empty === true;
      const refusedFinish = typeof r.raw.pool_error === 'string' && r.raw.pool_error;
      const exitFailed = typeof r.raw.exit_code === 'number' && r.raw.exit_code !== 0;
      empty = (empty ?? 0) + (isEmpty ? 1 : 0);
      failed = (failed ?? 0) + (exitFailed ? 1 : 0);
      refused = (refused ?? 0) + (refusedFinish ? 1 : 0);
      if (isEmpty || refusedFinish || exitFailed) {
        ev('empty-finishes', `jobs.jsonl finish job=${r.job ?? 'unknown'}${isEmpty ? ' empty' : ''}${exitFailed ? ` exit_code=${String(r.raw.exit_code)}` : ''}${refusedFinish ? ` pool_error=${String(r.raw.pool_error)}` : ''}`);
      }
      if (refusedFinish && QUOTA_ERRORS.has(String(r.raw.pool_error))) {
        quotaFinish = (quotaFinish ?? 0) + 1;
        ev('quota-exhaustion', `jobs.jsonl finish job=${r.job ?? 'unknown'} pool_error=${String(r.raw.pool_error)}`);
      }
      if (r.lane && r.raw.empty === false && Number.isFinite(r.at)) laneFinish.set(r.lane, Math.max(laneFinish.get(r.lane) ?? -1, r.at));
    }
    if (r.event === 'autobackoff_hold' && r.lane) {
      const authish = AUTH_RX.test(String(r.raw.pattern ?? '')) || typeof r.raw.auth_failures === 'number';
      if (authish) { authHolds = (authHolds ?? 0) + 1; laneAuthHold.set(r.lane, Math.max(laneAuthHold.get(r.lane) ?? -1, r.at)); ev('lane-auth', `jobs.jsonl autobackoff_hold lane=${r.lane}`); }
      else { quotaHoldJobs = (quotaHoldJobs ?? 0) + 1; ev('quota-exhaustion', `jobs.jsonl autobackoff_hold lane=${r.lane} pattern=${String(r.raw.pattern ?? '')}`); }
    }
    if (r.event === 'autobackoff_skip') quotaSkips = (quotaSkips ?? 0) + 1;
    if (r.event === 'authbackoff_skip') authSkips = (authSkips ?? 0) + 1;
    if (r.event === 'precheck_parked') precheckParks = (precheckParks ?? 0) + 1;
  }
  // A re-login is a nonempty finish on a lane after its newest auth hold.
  let relogins: number | null = jobs === null ? null : 0;
  for (const [lane, heldAt] of laneAuthHold) if ((laneFinish.get(lane) ?? -1) > heldAt) relogins!++;

  // ── dispatch-events.log ──────────────────────────────────────────────────
  const zero2 = z(input.events);
  const counts = { requeued: zero2, usage: zero2, capacity: zero2, auth: zero2, holds: zero2, unholds: zero2,
    credit: zero2, routes: zero2, routeHolds: zero2, routeInvalid: zero2, parked: zero2 };
  for (const line of events ?? []) {
    if (!in7d(line.at)) continue;
    const t = line.text;
    const bump = (k: keyof typeof counts) => { counts[k] = counts[k]! + 1; };
    // LAUNCH_SKIPPED carries "not requeued" inside its own parenthetical.
    if (/^LAUNCH_(DEFERRED|FAILED)\b/.test(t) || (/\brequeue/i.test(t) && !/not requeue/i.test(t))) {
      bump('requeued'); ev('requeues', `dispatch-events.log "${t}"`);
    }
    if (t.startsWith('USAGE_LIMIT_SEEN')) { bump('usage'); ev('quota-exhaustion', `dispatch-events.log "${t}"`); }
    if (t.startsWith('MODEL_CAPACITY_SEEN')) { bump('capacity'); ev('quota-exhaustion', `dispatch-events.log "${t}"`); }
    if (t.startsWith('AUTH_FAILURE_SEEN')) { bump('auth'); ev('lane-auth', `dispatch-events.log "${t}"`); }
    if (t.startsWith('LANE_HOLD')) {
      bump('holds'); ev('holds', `dispatch-events.log "${t}"`);
      if (/credits? exhausted/i.test(t)) { bump('credit'); ev('quota-exhaustion', `dispatch-events.log "${t}"`); }
      if (AUTH_RX.test(t)) ev('lane-auth', `dispatch-events.log "${t}"`);
    }
    if (t.startsWith('LANE_UNHOLD')) bump('unholds');
    if (/^PARKED\b/.test(t) || /^PARKED-DEP\b/.test(t)) { bump('parked'); ev('holds', `dispatch-events.log "${t}"`); }
    if (t.startsWith('ROUTE ')) { bump('routes'); ev('wrong-route', `dispatch-events.log "${t}"`); }
    if (t.startsWith('ROUTE_HOLD')) { bump('routeHolds'); ev('wrong-route', `dispatch-events.log "${t}"`); }
    if (t.startsWith('ROUTE_STATE_INVALID')) { bump('routeInvalid'); ev('wrong-route', `dispatch-events.log "${t}"`); }
  }
  const usageLimits = sum([counts.usage, counts.capacity, quotaSkips, quotaHoldJobs, quotaFinish, counts.credit]);
  const authFailures = sum([counts.auth, authHolds, authSkips]);

  // ── ready.tsv: invalid tiers, parked rows, unclaimed age ─────────────────
  // Dispatcher's contract (contrib/mac/dispatchd.py): positional rows are
  // `job \t repo \t lane \t tier \t prompt`; restock's status-first rows lead
  // with READY or PARKED-DEP.<lane> (`status \t job \t lane \t tier \t repo \t
  // prompt`). Both put the tier at index 3 — an upgraded queue may also carry
  // a header row, which then names the columns.
  let readyRows: number | null = null, badTierRows: number | null = null, parkedRows: number | null = null;
  let unclaimed: number | null = null, unknownAge: number | null = null, maxAgeH: number | null = null;
  if (input.ready != null) {
    readyRows = 0; badTierRows = 0; parkedRows = 0; unclaimed = 0; unknownAge = 0; maxAgeH = 0;
    const HEADER = new Set(['id', 'job', 'jobid', 'status', 'state', 'pool', 'lane', 'account', 'repo', 'repository', 'tier', 'prompt', 'title']);
    let columns: string[] | null = null;
    for (const raw of input.ready.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const cells = raw.replace(/\r$/, '').split('\t').map(c => c.trim());
      if (cells.length >= 2 && cells.every(c => HEADER.has(c.toLowerCase())) &&
          cells.some(c => /^(lane|pool|status)$/i.test(c))) { columns = cells.map(c => c.toLowerCase()); continue; }
      const first = cells[0] ?? '';
      const statusFirst = !columns && (/^READY$/i.test(first) || /^PARKED-/i.test(first));
      const pick = (...names: string[]): string => {
        for (const name of names) { const i = columns!.indexOf(name); if (i >= 0) return cells[i] ?? ''; }
        return '';
      };
      const id = (columns ? pick('id', 'job', 'jobid') : cells[statusFirst ? 1 : 0]) ?? '';
      const lane = (columns ? pick('lane', 'pool', 'account') : cells[2]) ?? '';
      const tier = (columns ? pick('tier') : cells[3]) ?? '';
      const status = (columns ? pick('status', 'state') : statusFirst ? first : 'READY').toUpperCase();
      const parked = /^PARKED-/i.test(status) || /^PARKED-/i.test(columns ? lane : cells[2] ?? '');
      if (parked) { parkedRows++; if (JID.test(id)) ev('holds', `ready.tsv parked job=${id}`); continue; }
      if (status !== 'READY') continue;
      readyRows++;
      if (tier && !TIERS.has(tier)) { badTierRows++; ev('invalid-tier', `ready.tsv job=${JID.test(id) ? id : '?'} tier=${cut(tier, 24)}`); }
      if (!JID.test(id) || !lane) continue;
      const at = enqueued.get(id);
      if (at === undefined) { unknownAge++; continue; }
      const done = (launched.get(id) ?? -1) >= at;
      if (done || now - at <= FRICTION_STALE_READY_MS) continue;
      unclaimed++; maxAgeH = Math.max(maxAgeH ?? 0, Math.floor((now - at) / 3_600_000));
      ev('stale-ready', `ready.tsv job=${id} waiting ${Math.floor((now - at) / 3_600_000)}h`);
    }
  }

  // ── guardian red-main, slots holds, manual files ─────────────────────────
  let reposRed: number | null = null, maxRedH: number | null = null;
  if (input.guardian != null) {
    const state = parseGuardianState(input.guardian);
    reposRed = 0; maxRedH = 0;
    for (const [repo, entry] of Object.entries(state ?? {})) {
      if (entry.state !== 'red') continue;
      reposRed++;
      const since = tsMs(entry.red_first) || tsMs(entry.red_since);
      const hours = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 3_600_000)) : 0;
      maxRedH = Math.max(maxRedH ?? 0, hours);
      ev('red-main', `guardian/state.json ${repo} red ${hours}h`);
    }
  }
  let lanesHeld: number | null = null, manualHolds: number | null = null;
  if (input.slots != null) {
    try {
      const table: unknown = JSON.parse(input.slots);
      lanesHeld = 0; manualHolds = 0;
      for (const [lane, v] of Object.entries(table && typeof table === 'object' && !Array.isArray(table) ? table as Record<string, unknown> : {})) {
        const row = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
        if (row.held !== true) continue;
        lanesHeld++; ev('holds', `slots.json ${lane} held`);
        if (row.held_by !== 'autobackoff') { manualHolds++; ev('manual-interventions', `slots.json ${lane} held_by=${String(row.held_by ?? 'manual')}`); }
      }
    } catch { lanesHeld = null; manualHolds = null; }
  }
  let overrideCount: number | null = null;
  if (input.overrides != null) {
    try {
      const table: unknown = JSON.parse(input.overrides);
      overrideCount = table && typeof table === 'object' && !Array.isArray(table) ? Object.keys(table).length : 0;
      if (overrideCount) ev('manual-interventions', `budget-overrides.json ${overrideCount} pool readings`);
    } catch { overrideCount = null; }
  }
  const kept = input.keep == null ? null : input.keep.split(/\s+/).filter(w => JID.test(w)).length;
  if (kept) ev('manual-interventions', `keep.txt ${kept} kept jobs`);

  // ── fold the ledger, score, project ──────────────────────────────────────
  const ledger = foldFrictionLedger(input.ledger ?? '');
  const bad = sum([empty, refused, failed]);
  const signals: Record<string, Record<string, number | null>> = {
    'empty-finishes': { bad, empty, refused, failed },
    'requeues': { requeued: events === null ? null : counts.requeued ?? 0 },
    'lane-auth': { auth_failures: authFailures, auth_holds: authHolds, relogins },
    'quota-exhaustion': { usage_limits: usageLimits, finish_errors: quotaFinish, credit_holds: counts.credit, model_capacity: counts.capacity, backoff_holds: quotaHoldJobs },
    'invalid-tier': { ready_rows: badTierRows, enqueued: badTierEnqueue },
    'red-main': { repos_red: reposRed, max_red_hours: maxRedH },
    'stale-ready': { unclaimed, unknown_age: unknownAge, max_age_hours: maxAgeH, queued: readyRows },
    'manual-interventions': { manual_holds: manualHolds, budget_overrides: overrideCount, kept_jobs: kept },
    'wrong-route': {
      route_moves: sum([counts.routes, counts.routeHolds, counts.routeInvalid]),
      route_holds: counts.routeHolds, state_invalid: counts.routeInvalid,
    },
    'holds': {
      hold_events: sum([counts.holds, counts.parked, precheckParks]),
      lanes_held: lanesHeld, parked_rows: parkedRows, parked_events: counts.parked,
      unholds: counts.unholds, precheck_parks: precheckParks,
    },
  };
  const items: FrictionItem[] = Object.entries(CATALOG).map(([id, spec]) => {
    const primary = signals[id]![spec.primary];
    const scan = ledger.scans.get(id);
    const note = ledger.notes.get(id);
    const open = primary !== null && primary > 0;
    let status: FrictionStatus = open ? 'open' : 'quiet';
    if (note) status = note.status === 'fixed' && open ? 'regressed' : note.status;
    return {
      id, title: spec.title, owner: note?.owner ?? spec.owner, status, signals: signals[id]!,
      metric: { unit: spec.primary, before: scan ? scan.before : null, after: primary },
      score: primary === null ? null : Math.round(spec.unlock * primary * spec.blast / spec.cost * 10) / 10,
      evidence: evidence[id]!,
    };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.id.localeCompare(b.id));
  const presence = (v: string | null | undefined): SourceState => v == null ? 'missing' : 'read';
  return { schema: 'phm.friction.v1', generatedAt: new Date(now).toISOString(), windowDays: 7,
    sources: input.sourceStates ?? {
      'metrics/jobs.jsonl': presence(input.jobs),
      'queue/dispatch-events.log': presence(input.events),
      'queue/ready.tsv': presence(input.ready),
      'guardian/state.json': presence(input.guardian),
      'queue/slots.json': presence(input.slots),
      'queue/budget-overrides.json': presence(input.overrides),
      'queue/keep.txt': presence(input.keep),
      'friction/ledger.jsonl': presence(input.ledger),
    }, items };
}

const TAIL = 8 * 1024 * 1024, SMALL = 256 * 1024;
/** Bounded reads of every friction source under a runs dir. */
export async function readFrictionInput(runsDir: string): Promise<FrictionInput> {
  const read = async (path: string, max: number, tail: boolean): Promise<{ text: string | null; state: SourceState }> => {
    const r = await readSource(path, max, tail);
    return { text: r.state === 'healthy' ? r.text : null,
      state: r.state === 'healthy' ? 'read' : r.state === 'missing' ? 'missing' : 'unreadable' };
  };
  const q = join(runsDir, 'queue');
  const [jobs, ready, guardian, slots, overrides, keep, ledger, queuedEvents] = await Promise.all([
    read(join(runsDir, 'metrics', 'jobs.jsonl'), TAIL, true),
    read(join(q, 'ready.tsv'), 2 * 1024 * 1024, false),
    read(join(runsDir, 'guardian', 'state.json'), SMALL, false),
    read(join(q, 'slots.json'), SMALL, false),
    read(join(q, 'budget-overrides.json'), SMALL, false),
    read(join(q, 'keep.txt'), SMALL, false),
    read(join(runsDir, 'friction', 'ledger.jsonl'), 1024 * 1024, true),
    read(join(q, 'dispatch-events.log'), TAIL, true),
  ]);
  const events = queuedEvents.text !== null ? queuedEvents : await read(join(runsDir, 'dispatch-events.log'), TAIL, true);
  const sourceStates = Object.fromEntries([
    ['metrics/jobs.jsonl', jobs.state], ['queue/dispatch-events.log', events.state],
    ['queue/ready.tsv', ready.state], ['guardian/state.json', guardian.state],
    ['queue/slots.json', slots.state], ['queue/budget-overrides.json', overrides.state],
    ['queue/keep.txt', keep.state], ['friction/ledger.jsonl', ledger.state],
  ]) as Record<string, SourceState>;
  return { jobs: jobs.text, events: events.text, ready: ready.text, guardian: guardian.text, slots: slots.text,
    overrides: overrides.text, keep: keep.text, ledger: ledger.text, sourceStates };
}

/** Append rows to friction/ledger.jsonl — the only file `phm friction` writes. */
export async function appendFrictionLedger(runsDir: string, lines: string[]): Promise<void> {
  if (!lines.length) return;
  const dir = join(runsDir, 'friction');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const handle = await open(join(dir, 'ledger.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { for (const line of lines) await handle.write(line.endsWith('\n') ? line : `${line}\n`); }
  finally { await handle.close(); }
}
