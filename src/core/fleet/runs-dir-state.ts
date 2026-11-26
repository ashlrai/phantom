/** Read-only dispatchd projection. Each source fails independently; no job contents are read. */
import { open, readdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { fleetNotRunning, type LaunchRecord, type NotRunningRow } from './fleet-held.js';
import { GLOBAL_SLOT_KEYS, LANE_ID_RE } from './runs-lane-targets.js';
import { ledgerEventName, ledgerJobId, ledgerLane, ledgerPrUrl, ledgerStamp } from './empty-cause.js';

export interface FleetRunsLane {
  seat?: { health: 'ok'|'degraded'|'down'|'unknown'; usedPct: number|null; resetAt: string|null; observedAt: string|null; passAt: string|null; passMs: number|null;
    /** Last provider rate limit and last failed leader pass on this lane; absent fields stay null (unknown). */
    rateLimitedAt?: string|null; failedAt?: string|null };
  healthy?: boolean; lane: string; running: number; target: number; floor: number|null; ceiling: number|null;
  /** The fleet controller's load-shed ceiling from status.json `effective_target`; null when the producer does not publish it. */
  effectiveTarget?: number|null;
  queued: number; held: boolean; heldReason: string|null; tokensLastHour: number|null;
  merged24h: number|null; mergeRate24h: number|null;
}
export interface FleetRunsEvent { at: string; kind: string; text: string }
export interface FleetRunsPublish { job: string; lane: string|null; url: string|null; at: string }
export interface FleetRunsClaim { job: string; lane: string; tier: string; at: string }
type Health = 'healthy'|'missing'|'degraded';
export interface FleetRunsDirState {
  leader?: { lane: string|null; model: string|null; lastSuccessAt: string|null };
  v: 1; generatedAt: string; runsDirPresent: boolean; sourceState: Health;
  sources: Record<'status'|'claimed'|'events'|'metrics'|'claudeLane'|'switches'|'drop', Health>;
  lastTick: string|null; paused: boolean|null; memFreePct: number|null; diskFreeGb: number|null;
  lanes: FleetRunsLane[]; switches: string[]; claudeLane: string|null;
  publishesLastHour: FleetRunsPublish[]; events: FleetRunsEvent[]; claimed: FleetRunsClaim[];
  drop: { pending: Array<{ lane: string; file: string }>; done: number };
  /** Additive: launched or staffed but not actually running, each with its reason and the one step that unblocks it. The reader always sets it. */
  notRunning?: NotRunningRow[];
}
export interface ReadFleetRunsDirOptions { runsDir?: string; now?: () => number }
const validLane = (lane: string): boolean => LANE_ID_RE.test(lane) && !GLOBAL_SLOT_KEYS.has(lane);
const ID = /^[A-Za-z0-9._-]{1,80}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const MAX = 8 * 1024 * 1024;
const TAIL = 1024 * 1024;
const SWITCHES = ['HOLD', 'PAUSE', 'ORCH_OFF', 'OPUS_LEADER_OFF', 'PUBLISH_HOLD', 'queue/DISABLE'];
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown): number|null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const timestamp = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v)) && new Date(`${v.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === v.slice(0, 10);
const safeId = (v: unknown): v is string => typeof v === 'string' && ID.test(v) && scrubSecrets(v) === v;
function pauseState(status: Record<string, unknown>): boolean|null {
  if (typeof status.paused === 'boolean') return status.paused;
  // The host dispatcher v1 writes a pause reason or explicit null. Only that
  // known producer schema gives null the meaning "not paused"; missing and
  // unknown representations must remain unavailable.
  if (status.schema === 'dispatchd.status.v1') {
    if (status.paused === null) return false;
    if (typeof status.paused === 'string' && status.paused.trim() && status.paused.length <= 500) return true;
  }
  return null;
}
function clean(text: string, max = 500): string {
  // Redact path tokens and prompt-bearing suffixes before exposing free text.
  return scrubSecrets(text).replace(/(?:[A-Za-z]:\\|~\/|\/)[^\s"'<>]*/g, '[path]')
    .replace(/\bprompt\s*[:=].*/i, 'prompt=[redacted]').replace(/\p{Cc}/gu, ' ').slice(0, max);
}

export function parseClaimedTsv(text: string): FleetRunsClaim[] {
  return text.split(/\r?\n/).flatMap(line => {
    const [job, lane, tier, clock, epoch, ...extra] = line.split('\t');
    if (!safeId(job) || !validLane(lane) || !safeId(tier) || extra.length ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock) || !/^\d{1,12}$/.test(epoch)) return [];
    const ms = Number(epoch) * 1000;
    return Number.isFinite(ms) && ms <= 8.64e15 ? [{ job, lane, tier, at: new Date(ms).toISOString() }] : [];
  });
}
export function parseDispatchEvents(text: string, limit = 40): FleetRunsEvent[] {
  const events: FleetRunsEvent[] = [];
  for (const line of text.trimEnd().split(/\r?\n/).slice(-400)) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([A-Z][A-Z0-9_-]{0,63})(?: (.*))?$/.exec(line);
    if (!m || !/^(?:LAUNCH|PUBLISHED|PUBLISH_START|PUBLISH_ABORT|LANE_HOLD|INCIDENT|INBOX|ORCH-[A-Z0-9-]*|OPUS-LEADER|LEADER|UPDATE-BRANCH|WT_QUARANTINED)$/.test(m[3])) continue;
    const at = `${m[1]}T${m[2]}Z`;
    if (timestamp(at)) events.push({ at, kind: m[3], text: clean(m[4] ?? '') });
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, Math.min(40, Math.max(0, Math.floor(limit) || 0)));
}
function metrics(text: string, nowMs: number) {
  const tokensByLane: Record<string, number> = {};
  const publishes: FleetRunsPublish[] = [];
  let corrupt = false;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    let row: Record<string, unknown>;
    try { row = object(JSON.parse(line)); } catch { corrupt = true; continue; }
    const job = ledgerJobId(row), stamp = ledgerStamp(row);
    // Every lane|pool field present must name a valid lane; a contradiction corrupts the row.
    const laneFields = [row.lane, row.pool];
    const laneBad = laneFields.some(value => value !== null && value !== undefined && !validLane(String(value)));
    if (!safeId(job) || !timestamp(stamp) || laneBad) { corrupt = true; continue; }
    const age = nowMs - Date.parse(stamp);
    if (age < 0 || age > 3600000) continue;
    const lane = ledgerLane(row);
    const event = ledgerEventName(row);
    if (event === 'finish' && lane && number(row.tokens_total) !== null) {
      const sum = (tokensByLane[lane] ?? 0) + (row.tokens_total as number);
      if (Number.isSafeInteger(sum)) tokensByLane[lane] = sum;
      else corrupt = true;
    } else if (event === 'publish' && row.class === 'pr') {
      const raw = ledgerPrUrl(row);
      const url = raw !== null && /^https:\/\/github\.com\/[^\s?#]+$/.test(raw) && scrubSecrets(raw) === raw ? raw : null;
      publishes.push({ job, lane, url, at: stamp });
    } else if (event === 'finish') corrupt = true;
  }
  publishes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { tokensByLane, publishes: publishes.slice(0, 50), corrupt };
}
export function parseJobsMetrics(text: string, nowMs: number): { tokensByLane: Record<string, number>; publishes: FleetRunsPublish[] } {
  const { tokensByLane, publishes } = metrics(text, nowMs);
  return { tokensByLane, publishes };
}

/** Descriptor-bound reads cap allocation even if dispatchd appends during the read. Symlinks are refused. */
async function read(path: string, tail = false): Promise<{ text: string; clipped: boolean }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (!tail && info.size > MAX)) throw new Error('invalid source');
    const start = tail ? Math.max(0, info.size - TAIL) : 0;
    const bytes = Buffer.alloc(Math.min(info.size, tail ? TAIL : MAX));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, start + offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const text = bytes.subarray(0, offset).toString('utf8');
    return { text: start ? text.slice(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n') + 1) : text, clipped: start > 0 };
  } finally { await file.close(); }
}
const missing = (e: unknown) => object(e).code === 'ENOENT';
const LAUNCH_WINDOW_MS = 7 * 86_400_000;
const LAUNCH_MAX = 500;
/** First lines of the newest `<job>.launch` records from the last week. Unreadable records are skipped; never throws. */
async function readLaunchRecords(root: string, now: number): Promise<LaunchRecord[]> {
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const published = new Set(names.filter(name => name.endsWith('.publish')).map(name => name.slice(0, -8)));
  const jobs = names.filter(name => name.endsWith('.launch')).map(name => name.slice(0, -7)).filter(safeId);
  const found: Array<{ job: string; ms: number }> = [];
  for (let i = 0; i < jobs.length; i += 64) {
    await Promise.all(jobs.slice(i, i + 64).map(async job => {
      try {
        const info = await lstat(join(root, `${job}.launch`));
        if (info.isFile() && info.mtimeMs <= now && now - info.mtimeMs <= LAUNCH_WINDOW_MS) found.push({ job, ms: info.mtimeMs });
      } catch { /* A record removed mid-scan is not a launch. */ }
    }));
  }
  const records: LaunchRecord[] = [];
  for (const { job, ms } of found.sort((a, b) => b.ms - a.ms || a.job.localeCompare(b.job)).slice(0, LAUNCH_MAX)) {
    try {
      const firstLine = clean((await read(join(root, `${job}.launch`))).text.split(/\r?\n/).find(line => line.trim()) ?? '', 300);
      records.push({ job, firstLine, at: new Date(ms).toISOString(), published: published.has(job) });
    } catch { /* Skip one unreadable record; the rest still report. */ }
  }
  return records;
}
export async function readFleetRunsDirState(opts: ReadFleetRunsDirOptions = {}): Promise<FleetRunsDirState> {
  const root = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const now = (opts.now ?? Date.now)();
  const state: FleetRunsDirState = {
    v: 1, generatedAt: new Date(now).toISOString(), runsDirPresent: false, sourceState: 'missing',
    sources: { status: 'missing', claimed: 'missing', events: 'missing', metrics: 'missing', claudeLane: 'missing', switches: 'missing', drop: 'missing' },
    lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, lanes: [], switches: [], claudeLane: null,
    publishesLastHour: [], events: [], claimed: [], drop: { pending: [], done: 0 }, notRunning: [],
  };
  try { if (!(await lstat(root)).isDirectory()) throw new Error('invalid directory'); state.runsDirPresent = true; }
  catch (e) { if (!missing(e)) state.sourceState = 'degraded'; return state; }
  async function guarded(key: keyof FleetRunsDirState['sources'], action: () => Promise<void>) {
    state.sources[key] = 'healthy';
    try { await action(); } catch (e) { state.sources[key] = missing(e) ? 'missing' : 'degraded'; }
  }
  let tokens: Record<string, number> = {};
  let launches: LaunchRecord[] = [];
  let metricsTail: { text: string; clipped: boolean } | null = null;
  await Promise.all([
    readLaunchRecords(root, now).then(records => { launches = records; }),
    guarded('status', async () => {
      const s = object(JSON.parse((await read(join(root, 'queue/status.json'))).text));
      const paused = pauseState(s);
      if (!timestamp(s.last_tick) || paused === null || number(s.mem_free_pct) === null || Number(s.mem_free_pct) > 100 || !s.lanes || Array.isArray(s.lanes) || typeof s.lanes !== 'object') throw new Error('invalid status');
      state.lastTick = s.last_tick; state.paused = paused; state.memFreePct = number(s.mem_free_pct);
      const leader = object(s.leader);
      state.leader = { lane: typeof leader.lane === 'string' && validLane(leader.lane) ? leader.lane : null,
        model: typeof leader.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(leader.model) && scrubSecrets(leader.model) === leader.model ? leader.model : null,
        lastSuccessAt: timestamp(leader.last_success_at) && Date.parse(leader.last_success_at) <= now ? leader.last_success_at : null };
      state.diskFreeGb = number(object(object(s.autopilot).disk).free_gb);
      for (const [lane, raw] of Object.entries(object(s.lanes))) {
        if (GLOBAL_SLOT_KEYS.has(lane)) continue;
        const l = object(raw);
        if (!validLane(lane) || !['running', 'target', 'queued'].every(k => number(l[k]) !== null && Number.isSafeInteger(l[k])) || !['floor', 'ceiling', 'effective_target'].every(k => l[k] == null || (number(l[k]) !== null && Number.isSafeInteger(l[k]))) || typeof l.held !== 'boolean') {
          state.sources.status = 'degraded'; continue;
        }
        const rollup = object(object(object(s.rollup_24h).by_lane)[lane]);
        const weekly = object(object(s.budget)[lane]);
        // No weekly reading: fall back to the lane's fresh use_it_all pace reading, observed at this tick.
        const pace = object(weekly.use_it_all);
        const budget = number(weekly.weekly_used_pct) === null && pace.known === true && pace.stale === false
          ? { weekly_used_pct: pace.used_pct, reset_at: pace.reset_at, observed_at: s.last_tick } : weekly;
        const health = l.health === 'ok' || l.health === 'degraded' || l.health === 'down' || l.health === 'unknown'
          ? l.health : l.healthy === true ? 'ok' : l.healthy === false ? 'down' : 'unknown';
        state.lanes.push({ lane, running: l.running as number, target: l.target as number, queued: l.queued as number,
          seat: { health, usedPct: number(budget.weekly_used_pct),
            resetAt: timestamp(budget.reset_at) ? budget.reset_at : null, observedAt: timestamp(budget.observed_at) ? budget.observed_at : null,
            passAt: timestamp(l.leader_pass_at) ? l.leader_pass_at : null, passMs: number(l.leader_pass_ms),
            rateLimitedAt: timestamp(l.rate_limited_at) ? l.rate_limited_at : null, failedAt: timestamp(l.leader_failed_at) ? l.leader_failed_at : null },
          ...(typeof l.healthy === 'boolean' ? { healthy: l.healthy } : {}),
          floor: number(l.floor), ceiling: number(l.ceiling), effectiveTarget: number(l.effective_target), held: l.held,
          heldReason: typeof l.held_reason === 'string' ? clean(l.held_reason, 200) : null,
          tokensLastHour: null, merged24h: number(rollup.merged), mergeRate24h: number(rollup.merge_rate) });
      }
    }),
    guarded('claimed', async () => {
      const { text } = await read(join(root, 'queue/claimed.tsv'));
      state.claimed = parseClaimedTsv(text);
      if (text.split(/\r?\n/).filter(Boolean).length !== state.claimed.length) state.sources.claimed = 'degraded';
    }),
    guarded('events', async () => {
      const tail = await read(join(root, 'dispatch-events.log'), true);
      const { text } = tail;
      state.events = parseDispatchEvents(text);
      if (tail.clipped && !text.trim() || text.trimEnd().split(/\r?\n/).slice(-400).filter(Boolean).some(line => {
        const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) [A-Z][A-Z0-9_-]{0,63}(?: |$)/.exec(line);
        return !match || !timestamp(`${match[1]}T${match[2]}Z`);
      })) state.sources.events = 'degraded';
    }),
    guarded('metrics', async () => {
      const tail = await read(join(root, 'metrics/jobs.jsonl'), true);
      metricsTail = tail;
      const result = metrics(tail.text, now);
      // A bounded tail proves individual publication events, but does not prove
      // complete hourly totals. Keep those unknown when any prefix was omitted.
      tokens = tail.clipped ? {} : result.tokensByLane; state.publishesLastHour = result.publishes;
      if (tail.clipped || result.corrupt) state.sources.metrics = 'degraded';
    }),
    guarded('claudeLane', async () => { state.claudeLane = clean((await read(join(root, 'queue/claude-lane.state'))).text.split(/\r?\n/)[0], 200) || null; }),
    guarded('switches', async () => {
      for (const name of SWITCHES) {
        try { await lstat(join(root, name)); state.switches.push(name); } catch (e) { if (!missing(e)) throw e; }
      }
    }),
    guarded('drop', async () => {
      const base = join(root, 'leader/drop');
      for (const entry of (await readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || (entry.name !== 'done' && !validLane(entry.name))) continue;
        for (const file of (await readdir(join(base, entry.name), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!file.isFile() || !file.name.endsWith('.md') || !safeId(file.name)) continue;
          if (entry.name === 'done') state.drop.done++;
          else if (state.drop.pending.length < 50) state.drop.pending.push({ lane: entry.name, file: file.name });
        }
      }
      if (!(await lstat(join(base, 'done'))).isDirectory()) throw new Error('invalid done directory');
    }),
  ]);
  for (const lane of state.lanes) lane.tokensLastHour = state.sources.metrics === 'healthy' ? tokens[lane.lane] ?? 0 : tokens[lane.lane] ?? null;
  const claimedLane = new Map(state.claimed.map(claim => [claim.job, claim.lane]));
  const tail = metricsTail as { text: string; clipped: boolean } | null;
  state.notRunning = fleetNotRunning({ lanes: state.lanes, launches: launches.map(record => ({ ...record, lane: claimedLane.get(record.job) ?? null })),
    metricsTail: tail?.text ?? null, metricsClipped: tail?.clipped ?? false, now });
  state.sourceState = Object.values(state.sources).every(s => s === 'healthy') ? 'healthy' : 'degraded';
  return state;
}
