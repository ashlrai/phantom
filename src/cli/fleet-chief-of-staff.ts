import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSource } from '../core/fleet/runs-parked-queue.js';
import { parseFleetSnapshot, planChiefOfStaff, type FleetSnapshot } from '../core/fleet/chief-of-staff.js';

const usage = 'Usage: phm fleet chief-of-staff [--snapshot <path|auto>] [--json|--brief]';
const MAX_BYTES = 1024 * 1024;
type Row = Record<string, unknown>;
type Sources = Record<string, 'healthy' | 'unavailable' | 'degraded' | 'bounded'>;
export interface FleetChiefOfStaffDeps {
  read?: (path: string) => Promise<string>;
  runsDir?: string;
  now?: () => Date;
  out?: (text: string) => void;
  err?: (text: string) => void;
}
const object = (v: unknown): Row => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const integer = (v: unknown): number | null => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 1_000_000 ? Number(v) : null;
const safeId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
function timestamp(v: unknown): string | null {
  const ms = typeof v === 'number' ? v * 1000 : typeof v === 'string' && v.length <= 40
    && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(v) ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : null;
}

/** Adapter for dispatcher captures. No writes, prompt reads or provider queries. */
async function autoSnapshot(read: (path: string) => Promise<string>, root: string, at: string, sources: Sources): Promise<FleetSnapshot> {
  const names = ['queue/ready.tsv', 'queue/slots.json', 'queue/resources.json', 'queue/status.json', 'metrics/jobs.jsonl', 'fleet/open-prs.json'];
  const texts = await Promise.all(names.map(async name => {
    try { const text = await read(join(root, name)); sources[name] = 'healthy'; return text; }
    catch { sources[name] = 'unavailable'; return ''; }
  }));
  function json(index: number): unknown {
    if (sources[names[index]] === 'unavailable') return null;
    try {
      const value: unknown = JSON.parse(texts[index]);
      if (index !== 5 && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error();
      return value;
    } catch { sources[names[index]] = 'degraded'; return null; }
  }
  function lanes(value: unknown): Row {
    const row = object(value);
    if (Object.hasOwn(row, 'lanes') && (!row.lanes || typeof row.lanes !== 'object' || Array.isArray(row.lanes))) throw new Error('Invalid fleet snapshot');
    const map = Object.hasOwn(row, 'lanes') ? object(row.lanes) : row;
    if (Object.keys(map).length > 66) throw new Error('Invalid fleet snapshot');
    return map;
  }
  const slots = lanes(json(1)), resources = lanes(json(2)), status = object(json(3));
  const tick = timestamp(status.last_tick);
  const fresh = tick !== null && Date.parse(at) - Date.parse(tick) >= 0 && Date.parse(at) - Date.parse(tick) <= 60_000;
  if (!fresh && sources[names[3]] === 'healthy') sources[names[3]] = 'degraded';
  const live = fresh ? lanes(status) : {};
  const jobs: FleetSnapshot['jobs'] = [];
  for (const line of texts[0].split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [id, , lane] = line.split('\t');
    if (id === 'id' || id?.startsWith('PARKED-') || lane?.startsWith('PARKED-')) continue;
    if (!safeId(id) || !safeId(lane) || jobs.some(j => j.id === id) || jobs.length >= 200) { sources[names[0]] = 'degraded'; continue; }
    jobs.push({ id, lane, status: 'ready', priority: 50, queuedAt: null, startedAt: null });
  }
  // A partial queue cannot safely establish either ordering or empty-lane demand.
  if (sources[names[0]] !== 'healthy') jobs.length = 0;
  const outcomes: FleetSnapshot['outcomes'] = [];
  const ledger = texts[4].split(/\r?\n/).filter(Boolean);
  if (sources[names[4]] === 'healthy') sources[names[4]] = 'bounded';
  for (const line of ledger.slice(-1000)) {
    let row: Row;
    try { row = object(JSON.parse(line)); } catch { sources[names[4]] = 'degraded'; continue; }
    if (row.event !== 'finish' && row.event !== 'publish') continue;
    const job = row.job ?? row.job_id ?? row.jobId, lane = row.lane ?? row.pool;
    const when = timestamp(row.ts ?? row.at ?? row.timestamp);
    const result = typeof row.exit_code === 'number' && row.exit_code !== 0 ? 'failed'
      : row.empty === true ? 'empty' : row.exit_code === 0 ? 'success'
      : row.result === 'success' || row.result === 'failed' ? row.result : null;
    // A publish event without a success result still needs a recorded PR URL.
    const published = row.event === 'publish' && typeof (row.url ?? row.pr_url) === 'string'
      && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(String(row.url ?? row.pr_url));
    if (!safeId(job) || !safeId(lane) || !when || (!result && !published)) { sources[names[4]] = 'degraded'; continue; }
    outcomes.push({ job, lane, at: when, phase: row.event, result: result ?? 'success', empty: typeof row.empty === 'boolean' ? row.empty : undefined });
  }
  const prs = json(5);
  const conflicts = new Map<string, number>();
  let knownPrs = Array.isArray(prs) && prs.length <= 1000;
  if (knownPrs) for (const value of prs as unknown[]) {
    const row = object(value);
    if (!safeId(row.lane) || !['MERGEABLE', 'CONFLICTING'].includes(String(row.mergeable))) { knownPrs = false; break; }
    if (row.mergeable === 'CONFLICTING') conflicts.set(row.lane, (conflicts.get(row.lane) ?? 0) + 1);
  }
  if (!knownPrs && sources[names[5]] === 'healthy') sources[names[5]] = 'degraded';
  const laneIds = [...new Set([...Object.keys(slots).filter(k => !['hard_cap', 'last_change_by'].includes(k)), ...jobs.map(j => j.lane)])];
  return parseFleetSnapshot({ at, jobs, outcomes, lanes: laneIds.map(lane => {
    const slot = object(slots[lane]), resource = object(resources[lane]), state = object(live[lane]);
    const finishes = [...new Map(outcomes.filter(o => o.lane === lane && o.phase === 'finish'
      && Date.parse(o.at) <= Date.parse(at) && Date.parse(o.at) >= Date.parse(at) - 86_400_000).map(o => [`${o.job}:${o.at}`, o])).values()];
    const resetAt = timestamp(resource.reset_at), used = resource.used_frac;
    const held = slot.held === true || state.held === true || (fresh && Boolean(status.paused)) ? true
      : fresh && (status.paused === null || status.paused === false) && state.held === false && (slot.held === undefined || slot.held === false) ? false : null;
    const ceiling = integer(slot.ceiling), cap = integer(slot.hard_cap);
    const target = integer(slot.target), effectiveCeiling = ceiling === null ? null : Math.min(ceiling, cap ?? ceiling);
    const errors = finishes.filter(o => o.result !== 'empty'), empties = finishes.filter(o => o.empty !== undefined || o.result === 'empty');
    return { lane, held, target, ceiling: effectiveCeiling,
      running: integer(state.running), queueDepth: sources[names[0]] === 'healthy' ? jobs.filter(j => j.lane === lane).length : null,
      errorRate: errors.length ? errors.filter(o => o.result === 'failed').length / errors.length : null,
      emptyRate: empties.length ? empties.filter(o => o.result === 'empty' || o.empty === true).length / empties.length : null,
      openPrConflicts: knownPrs ? conflicts.get(lane) ?? 0 : null,
      quota: resetAt && typeof used === 'number' && Number.isFinite(used) && used >= 0 ? { remainingFraction: Math.max(0, 1 - used), resetAt } : null };
  }) });
}

export async function cmdFleetChiefOfStaff(args: string[], deps: FleetChiefOfStaffDeps = {}): Promise<number> {
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { out(usage); return 0; }
  let path = 'auto', seen = false, mode: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--snapshot' && !seen && args[i + 1] && !args[i + 1].startsWith('-')) { path = args[++i]; seen = true; }
    else if (['--json', '--brief'].includes(args[i]) && !mode) mode = args[i];
    else { err(usage); return 2; }
  }
  const sources: Sources = {};
  const read = async (file: string): Promise<string> => {
    const text = deps.read ? await deps.read(file) : await (async () => {
      const source = await readSource(file, MAX_BYTES, path === 'auto' && file.endsWith('/metrics/jobs.jsonl'));
      if (source.state !== 'healthy') throw new Error('Unavailable source');
      return source.text;
    })();
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Oversized source');
    return text;
  };
  try {
    const snapshot = path === 'auto'
      ? await autoSnapshot(read, deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), (deps.now ?? (() => new Date()))().toISOString(), sources)
      : parseFleetSnapshot(JSON.parse(await read(path)));
    const plan = planChiefOfStaff(snapshot);
    if (mode === '--brief') out(plan.brief.text + (path === 'auto' ? '\n\nSources: ' + Object.entries(sources).map(([name, state]) => `${name}: ${state}`).join('; ') : ''));
    else out(JSON.stringify({ ...plan, sources }));
    return Object.values(sources).some(s => s === 'unavailable' || s === 'degraded') ? 1 : 0;
  } catch { err('chief-of-staff: snapshot unavailable or invalid'); return 1; }
}
