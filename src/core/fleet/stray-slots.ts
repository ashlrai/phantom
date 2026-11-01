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

export const VERSE_FLEET_CONTROL_STRAY_SLOTS_PATH = '/api/verse/fleet/control/stray-slots';

/** Job and lane ids are filesystem and metrics tokens: bounded, no slashes. */
export const STRAY_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

export interface StrayProcess { pid: number; elapsed: string; command: string; cwd: string | null }
export interface StrayJob { id: string; lane: string; finished: boolean; worktree: string }
export interface StrayReaders {
  readProcesses: () => Promise<StrayProcess[]>;
  readJobs: () => Promise<StrayJob[]>;
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
  const [processes, jobs] = await Promise.all([readers.readProcesses(), readers.readJobs()]);
  const live = new Set(parsePsTable(processes.map(p => `${p.pid} ${p.elapsed} ${p.command}`).join('\n')).workers.map(p => p.job));
  const lanes = new Map<string, StraySlotLane>();
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

/** Bounded descriptor reads: never follow links into credentials or block on a FIFO. */
async function text(path: string, limit: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('invalid source');
    const bytes = Buffer.alloc(Math.min(stat.size, limit));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
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
      const result = await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn', '-w'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
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
    const metrics = await text(join(root, 'metrics/jobs.jsonl'), 8 * 1024 * 1024);
    const latest = new Map<string, { lane: string; finished: boolean }>();
    for (const line of metrics.split('\n').filter(Boolean)) {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.job === 'string' && STRAY_ID_PATTERN.test(row.job) && typeof row.lane === 'string' && STRAY_ID_PATTERN.test(row.lane) &&
          ['start', 'launch', 'finish'].includes(String(row.event))) {
        latest.set(row.job, { lane: row.lane, finished: row.event === 'finish' });
      }
    }
    const jobs: StrayJob[] = [];
    for (const [id, state] of latest) {
      const base = await text(join(root, `${id}.base`), 16 * 1024);
      const match = /^\S+\s+\S+\s+([^\r\n]+)/.exec(base);
      if (!match || !isAbsolute(match[1])) throw new Error('invalid worktree');
      jobs.push({ id, ...state, worktree: match[1].trim() });
    }
    return jobs;
  },
};
