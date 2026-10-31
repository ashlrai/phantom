/** Read-only dispatchd projection. Each source fails independently; no job contents are read. */
import { open, readdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';

export interface FleetRunsLane {
  lane: string; running: number; target: number; floor: number|null; ceiling: number|null;
  queued: number; held: boolean; heldReason: string|null; tokensLastHour: number|null;
  merged24h: number|null; mergeRate24h: number|null;
}
export interface FleetRunsEvent { at: string; kind: string; text: string }
export interface FleetRunsPublish { job: string; lane: string|null; url: string|null; at: string }
export interface FleetRunsClaim { job: string; lane: string; tier: string; at: string }
type Health = 'healthy'|'missing'|'degraded';
export interface FleetRunsDirState {
  v: 1; generatedAt: string; runsDirPresent: boolean; sourceState: Health;
  sources: Record<'status'|'claimed'|'events'|'metrics'|'claudeLane'|'switches'|'drop', Health>;
  lastTick: string|null; paused: boolean|null; memFreePct: number|null; diskFreeGb: number|null;
  lanes: FleetRunsLane[]; switches: string[]; claudeLane: string|null;
  publishesLastHour: FleetRunsPublish[]; events: FleetRunsEvent[]; claimed: FleetRunsClaim[];
  drop: { pending: Array<{ lane: string; file: string }>; done: number };
}
export interface ReadFleetRunsDirOptions { runsDir?: string; now?: () => number }
const LANES = new Set(['codex-cmp', 'codex-personal', 'claude', 'devin', 'claude-api', 'codex-local']);
const ID = /^[A-Za-z0-9._-]{1,80}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const MAX = 8 * 1024 * 1024;
const TAIL = 1024 * 1024;
const SWITCHES = ['HOLD', 'PAUSE', 'ORCH_OFF', 'OPUS_LEADER_OFF', 'PUBLISH_HOLD', 'queue/DISABLE'];
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown): number|null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const timestamp = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v)) && new Date(`${v.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === v.slice(0, 10);
const safeId = (v: unknown): v is string => typeof v === 'string' && ID.test(v) && scrubSecrets(v) === v;
function clean(text: string, max = 500): string {
  // Redact path tokens and prompt-bearing suffixes before exposing free text.
  return scrubSecrets(text).replace(/(?:[A-Za-z]:\\|~\/|\/)[^\s"'<>]*/g, '[path]')
    .replace(/\bprompt\s*[:=].*/i, 'prompt=[redacted]').replace(/\p{Cc}/gu, ' ').slice(0, max);
}

export function parseClaimedTsv(text: string): FleetRunsClaim[] {
  return text.split(/\r?\n/).flatMap(line => {
    const [job, lane, tier, clock, epoch, ...extra] = line.split('\t');
    if (!safeId(job) || !LANES.has(lane) || !safeId(tier) || extra.length ||
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
    if (!safeId(row.job) || !timestamp(row.ts) || (row.lane != null && !LANES.has(String(row.lane)))) { corrupt = true; continue; }
    const age = nowMs - Date.parse(row.ts);
    if (age < 0 || age > 3600000) continue;
    const lane = typeof row.lane === 'string' ? row.lane : null;
    if (row.event === 'finish' && lane && number(row.tokens_total) !== null) {
      const sum = (tokensByLane[lane] ?? 0) + (row.tokens_total as number);
      if (Number.isSafeInteger(sum)) tokensByLane[lane] = sum;
      else corrupt = true;
    } else if (row.event === 'publish' && row.class === 'pr') {
      const url = typeof row.url === 'string' && /^https:\/\/github\.com\/[^\s?#]+$/.test(row.url) && scrubSecrets(row.url) === row.url ? row.url : null;
      publishes.push({ job: row.job, lane, url, at: row.ts });
    } else if (row.event === 'finish') corrupt = true;
  }
  publishes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { tokensByLane, publishes: publishes.slice(0, 50), corrupt };
}
export function parseJobsMetrics(text: string, nowMs: number): { tokensByLane: Record<string, number>; publishes: FleetRunsPublish[] } {
  const { tokensByLane, publishes } = metrics(text, nowMs);
  return { tokensByLane, publishes };
}

/** Descriptor-bound reads cap allocation even if dispatchd appends during the read. Symlinks are refused. */
async function read(path: string, tail = false): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX) throw new Error('invalid source');
    const start = tail ? Math.max(0, info.size - TAIL) : 0;
    const bytes = Buffer.alloc(Math.min(info.size, tail ? TAIL : MAX));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, start + offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const text = bytes.subarray(0, offset).toString('utf8');
    return start ? text.slice(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n') + 1) : text;
  } finally { await file.close(); }
}
const missing = (e: unknown) => object(e).code === 'ENOENT';
export async function readFleetRunsDirState(opts: ReadFleetRunsDirOptions = {}): Promise<FleetRunsDirState> {
  const root = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const now = (opts.now ?? Date.now)();
  const state: FleetRunsDirState = {
    v: 1, generatedAt: new Date(now).toISOString(), runsDirPresent: false, sourceState: 'missing',
    sources: { status: 'missing', claimed: 'missing', events: 'missing', metrics: 'missing', claudeLane: 'missing', switches: 'missing', drop: 'missing' },
    lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, lanes: [], switches: [], claudeLane: null,
    publishesLastHour: [], events: [], claimed: [], drop: { pending: [], done: 0 },
  };
  try { if (!(await lstat(root)).isDirectory()) throw new Error('invalid directory'); state.runsDirPresent = true; }
  catch (e) { if (!missing(e)) state.sourceState = 'degraded'; return state; }
  async function guarded(key: keyof FleetRunsDirState['sources'], action: () => Promise<void>) {
    state.sources[key] = 'healthy';
    try { await action(); } catch (e) { state.sources[key] = missing(e) ? 'missing' : 'degraded'; }
  }
  let tokens: Record<string, number> = {};
  await Promise.all([
    guarded('status', async () => {
      const s = object(JSON.parse(await read(join(root, 'queue/status.json'))));
      if (!timestamp(s.last_tick) || typeof s.paused !== 'boolean' || number(s.mem_free_pct) === null || Number(s.mem_free_pct) > 100 || !s.lanes || Array.isArray(s.lanes) || typeof s.lanes !== 'object') throw new Error('invalid status');
      state.lastTick = s.last_tick; state.paused = s.paused; state.memFreePct = number(s.mem_free_pct);
      state.diskFreeGb = number(object(object(s.autopilot).disk).free_gb);
      for (const [lane, raw] of Object.entries(object(s.lanes))) {
        const l = object(raw);
        if (!LANES.has(lane) || !['running', 'target', 'queued'].every(k => number(l[k]) !== null && Number.isSafeInteger(l[k])) || !['floor', 'ceiling'].every(k => l[k] == null || (number(l[k]) !== null && Number.isSafeInteger(l[k]))) || typeof l.held !== 'boolean') {
          state.sources.status = 'degraded'; continue;
        }
        const rollup = object(object(object(s.rollup_24h).by_lane)[lane]);
        state.lanes.push({ lane, running: l.running as number, target: l.target as number, queued: l.queued as number,
          floor: number(l.floor), ceiling: number(l.ceiling), held: l.held,
          heldReason: typeof l.held_reason === 'string' ? clean(l.held_reason, 200) : null,
          tokensLastHour: null, merged24h: number(rollup.merged), mergeRate24h: number(rollup.merge_rate) });
      }
    }),
    guarded('claimed', async () => {
      const text = await read(join(root, 'queue/claimed.tsv'));
      state.claimed = parseClaimedTsv(text);
      if (text.split(/\r?\n/).filter(Boolean).length !== state.claimed.length) state.sources.claimed = 'degraded';
    }),
    guarded('events', async () => {
      const text = await read(join(root, 'dispatch-events.log'));
      state.events = parseDispatchEvents(text);
      if (text.trimEnd().split(/\r?\n/).slice(-400).filter(Boolean).some(line => {
        const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) [A-Z][A-Z0-9_-]{0,63}(?: |$)/.exec(line);
        return !match || !timestamp(`${match[1]}T${match[2]}Z`);
      })) state.sources.events = 'degraded';
    }),
    guarded('metrics', async () => {
      const result = metrics(await read(join(root, 'metrics/jobs.jsonl'), true), now);
      tokens = result.tokensByLane; state.publishesLastHour = result.publishes;
      if (result.corrupt) state.sources.metrics = 'degraded';
    }),
    guarded('claudeLane', async () => { state.claudeLane = clean((await read(join(root, 'queue/claude-lane.state'))).split(/\r?\n/)[0], 200) || null; }),
    guarded('switches', async () => {
      for (const name of SWITCHES) {
        try { await lstat(join(root, name)); state.switches.push(name); } catch (e) { if (!missing(e)) throw e; }
      }
    }),
    guarded('drop', async () => {
      const base = join(root, 'leader/drop');
      for (const entry of (await readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || (entry.name !== 'done' && !LANES.has(entry.name))) continue;
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
  state.sourceState = Object.values(state.sources).every(s => s === 'healthy') ? 'healthy' : 'degraded';
  return state;
}
