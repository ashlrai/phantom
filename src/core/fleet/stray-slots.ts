/**
 * Stray-slot evidence: one lost slot per finished job whose worktree still has
 * live processes. Pure readers-in / report-out logic plus the host readers
 * (ps, lsof or /proc, ~/.ashlr-runs metrics) — the CLI
 * (src/cli/fleet-stray-slots.ts) and the fleet-control API route
 * (GET /api/verse/fleet/control/stray-slots) both serve this report.
 * Observation only: nothing here sends signals or mutates state.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { promisify } from 'node:util';
import { scrubSecrets } from '../util/scrub.js';
import { parseEtime, parsePsTable } from './runs-live-workers.js';
import { ledgerEventName, ledgerJobId, ledgerLane } from './empty-cause.js';

export const VERSE_FLEET_CONTROL_STRAY_SLOTS_PATH = '/api/verse/fleet/control/stray-slots';

/** Job and lane ids are filesystem and metrics tokens: bounded, no slashes. */
export const STRAY_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

export interface StrayProcess { pid: number; elapsed: string; command: string; cwd: string | null }
export interface StrayJob { id: string; lane: string; finished: boolean; worktree: string }
export interface StrayReaders {
  readProcesses: () => Promise<StrayProcess[]>;
  readJobs: () => Promise<StrayJob[]>;
  /** Lane names the daemon knows (queue/status.json), so an idle lane still counts as checked. Optional. */
  readLanes?: () => Promise<string[]>;
}

/** One leftover process still holding a finished job's worktree. */
export interface StraySlotStray { job: string; pid: number; ageSeconds: number | null }
export interface StraySlotLane { lane: string; slotsLost: number; strays: StraySlotStray[] }
export interface StraySlotsReport { lanes: StraySlotLane[] }

/** GET /api/verse/fleet/control/stray-slots payload. */
export interface StraySlotsV1 {
  v: 1;
  generatedAt: string;
  /** 'unavailable' means the host evidence could not be read at all. */
  source: 'ok' | 'unavailable';
  lanes: StraySlotLane[];
}

const run = promisify(execFile);

function inside(path: string, root: string): boolean {
  if (!isAbsolute(path) || !isAbsolute(root) || normalize(root) === '/') return false;
  const suffix = relative(root, path);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix));
}

function commandInside(command: string, root: string): boolean {
  // Quoted paths, executable paths and --flag=/path all have explicit boundaries.
  const escaped = normalize(root).replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = command.matchAll(new RegExp(`(?:^|[\\s="'])(${escaped}(?:/[^\\s"']*)?)(?=$|[\\s"'])`, 'g'));
  return [...matches].some(match => inside(match[1], root));
}

export async function readStraySlots(readers: StrayReaders = defaultStrayReaders, selectedLanes?: ReadonlySet<string>): Promise<StraySlotsReport> {
  const [processes, jobs, known] = await Promise.all([readers.readProcesses(), readers.readJobs(), readers.readLanes?.() ?? []]);
  const live = new Set(parsePsTable(processes.map(p => `${p.pid} ${p.elapsed} ${p.command}`).join('\n')).workers.map(p => p.job));
  const lanes = new Map<string, StraySlotLane>();
  for (const name of known) {
    if (STRAY_ID_PATTERN.test(name) && (!selectedLanes || selectedLanes.has(name))) lanes.set(name, { lane: scrubSecrets(name), slotsLost: 0, strays: [] });
  }
  for (const job of new Map(jobs.map(job => [job.id, job])).values()) {
    if (selectedLanes && !selectedLanes.has(job.lane)) continue;
    if (!STRAY_ID_PATTERN.test(job.id) || !STRAY_ID_PATTERN.test(job.lane) || !isAbsolute(job.worktree) || normalize(job.worktree) === '/') continue;
    let lane = lanes.get(job.lane);
    if (!lane) { lane = { lane: scrubSecrets(job.lane), slotsLost: 0, strays: [] }; lanes.set(job.lane, lane); }
    if (!job.finished || live.has(job.id)) continue;
    const strays = processes.filter(p => Number.isSafeInteger(p.pid) && p.pid > 0 &&
      ((p.cwd !== null && inside(p.cwd, job.worktree)) || commandInside(p.command, job.worktree)));
    const unique = [...new Map(strays.map(p => [p.pid, p])).values()];
    if (unique.length) lane.slotsLost++;
    lane.strays.push(...unique.map(p => ({ job: scrubSecrets(job.id), pid: p.pid, ageSeconds: parseEtime(p.elapsed) })));
  }
  return { lanes: [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane)).map(lane =>
    ({ ...lane, strays: lane.strays.sort((a, b) => a.job.localeCompare(b.job) || a.pid - b.pid) })) };
}

/** An evidence file that cannot be used; the message names the file and says what is wrong. */
export class StraySourceError extends Error {
  constructor(path: string, problem: 'missing' | 'not JSON' | 'not a regular file' | 'unexpected shape') {
    super(problem === 'unexpected shape' ? `${path} has an unexpected shape` : `${path} is ${problem}`);
    this.name = 'StraySourceError';
  }
}

/**
 * Bounded descriptor reads: never follow links into credentials or block on a FIFO.
 * A file bigger than `limit` yields its last `limit` bytes (whole lines only), which is all
 * the append-only ledger needs: the latest row per job wins.
 */
async function text(path: string, limit: number): Promise<string> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new StraySourceError(path, code === 'ENOENT' ? 'missing' : 'not a regular file');
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new StraySourceError(path, 'not a regular file');
    const length = Math.min(stat.size, limit);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, stat.size - length);
    const body = bytes.subarray(0, bytesRead).toString('utf8');
    return length < stat.size ? body.slice(body.indexOf('\n') + 1) : body;
  } finally { await file.close(); }
}

/**
 * Latest lifecycle state per job from jobs.jsonl text, in the jobs-ledger
 * field dialect (job|job_id|jobId|id, event|type|kind, lane|pool). A start,
 * launch or finish row claims the job; the last matching row wins. Throws on
 * a malformed line, same as the ledger read it replaces.
 */
export function strayJobStates(metrics: string): Map<string, { lane: string; finished: boolean }> {
  const latest = new Map<string, { lane: string; finished: boolean }>();
  for (const line of metrics.split('\n').filter(Boolean)) {
    const row: unknown = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const job = ledgerJobId(record), lane = ledgerLane(record), event = ledgerEventName(record);
    if (job !== null && STRAY_ID_PATTERN.test(job) && lane !== null && STRAY_ID_PATTERN.test(lane) &&
        (event === 'start' || event === 'launch' || event === 'finish')) {
      latest.set(job, { lane, finished: event === 'finish' });
    }
  }
  return latest;
}

export const defaultStrayReaders: StrayReaders = {
  async readProcesses() {
    const { stdout } = await run('/bin/ps', ['-axo', 'pid=,etime=,command='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const rows: StrayProcess[] = stdout.split('\n').flatMap(line => {
      const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return m ? [{ pid: Number(m[1]), elapsed: m[2], command: m[3], cwd: null }] : [];
    });
    if (process.platform === 'linux') {
      await Promise.all(rows.map(async row => {
        try { row.cwd = await readlink(`/proc/${row.pid}/cwd`); }
        catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      }));
    } else if (process.platform === 'darwin') {
      // lsof exits 1 when it cannot read some processes' cwd but still prints the rest; keep what it printed.
      const result = await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn', '-w'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
        .catch((error: { code?: unknown; stdout?: unknown }) => {
          if (error.code === 1 && typeof error.stdout === 'string' && error.stdout) return { stdout: error.stdout };
          throw error;
        });
      const byPid = new Map(rows.map(row => [row.pid, row]));
      let pid = 0;
      for (const line of result.stdout.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        else if (line.startsWith('n')) { const row = byPid.get(pid); if (row) row.cwd = line.slice(1); }
      }
    } else throw new Error('unsupported host');
    return rows;
  },
  async readJobs() {
    const root = join(homedir(), '.ashlr-runs');
    const ledger = join(root, 'metrics/jobs.jsonl');
    const metrics = await text(ledger, 8 * 1024 * 1024);
    let latest;
    try { latest = strayJobStates(metrics); } catch { throw new StraySourceError(ledger, 'not JSON'); }
    const jobs: StrayJob[] = [];
    for (const [id, state] of latest) {
      // A job with no readable base file has no known worktree, so it cannot hold a stray: skip it, do not fail the whole read.
      const base = await text(join(root, `${id}.base`), 16 * 1024).catch(() => null);
      const match = base === null ? null : /^\S+\s+\S+\s+([^\r\n]+)/.exec(base);
      if (!match || !isAbsolute(match[1])) continue;
      jobs.push({ id, ...state, worktree: match[1].trim() });
    }
    return jobs;
  },
  async readLanes() {
    const file = join(homedir(), '.ashlr-runs', 'queue/status.json');
    return strayStatusLanes(await text(file, 1024 * 1024), file);
  },
};

/** Lane names from a dispatchd.status.v1 document: `lanes` is an object keyed by lane name. */
export function strayStatusLanes(body: string, file: string): string[] {
  let doc: unknown;
  try { doc = JSON.parse(body); } catch { throw new StraySourceError(file, 'not JSON'); }
  const lanes = doc && typeof doc === 'object' ? (doc as { lanes?: unknown }).lanes : undefined;
  if (!lanes || typeof lanes !== 'object' || Array.isArray(lanes)) throw new StraySourceError(file, 'unexpected shape');
  return Object.keys(lanes);
}
