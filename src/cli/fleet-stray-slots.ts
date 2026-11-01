/** Read-only host evidence: one lost slot per finished job with leftover processes. */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { promisify } from 'node:util';
import { parseEtime, parsePsTable } from '../core/fleet/runs-live-workers.js';
import { scrubSecrets } from '../core/util/scrub.js';

export interface StrayProcess { pid: number; elapsed: string; command: string; cwd: string | null }
export interface StrayJob { id: string; lane: string; finished: boolean; worktree: string }
export interface StrayReaders {
  readProcesses: () => Promise<StrayProcess[]>;
  readJobs: () => Promise<StrayJob[]>;
}
const run = promisify(execFile);
const usage = `Usage: ashlr fleet stray-slots [--json] [--check] [--lane NAME ...]
  --lane NAME  Select an exact lane; repeat to select multiple lanes (default: all).
  --check      Exit 1 for observed lost slots or unavailable evidence, 0 otherwise.
No matching jobs means no observed stray slots, not proof a provider is available.
Observation only: never sends signals, mutates slot counts, launches work or releases holds.`;
const idPattern = /^[A-Za-z0-9._-]{1,80}$/;

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

export async function readStraySlots(readers: StrayReaders = defaultReaders, selectedLanes?: ReadonlySet<string>) {
  const [processes, jobs] = await Promise.all([readers.readProcesses(), readers.readJobs()]);
  const live = new Set(parsePsTable(processes.map(p => `${p.pid} ${p.elapsed} ${p.command}`).join('\n')).workers.map(p => p.job));
  const lanes = new Map<string, { lane: string; slotsLost: number; strays: Array<{ job: string; pid: number; ageSeconds: number | null }> }>();
  for (const job of new Map(jobs.map(job => [job.id, job])).values()) {
    if (selectedLanes && !selectedLanes.has(job.lane)) continue;
    if (!idPattern.test(job.id) || !idPattern.test(job.lane) || !isAbsolute(job.worktree) || normalize(job.worktree) === '/') continue;
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

const defaultReaders: StrayReaders = {
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
      if (typeof row.job === 'string' && idPattern.test(row.job) && typeof row.lane === 'string' && idPattern.test(row.lane) &&
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

export async function cmdFleetStraySlots(args: string[], readers: StrayReaders = defaultReaders): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return 0; }
  let json = false;
  let check = false;
  const selectedLanes = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--check' && !check) check = true;
    else if (arg === '--lane' && i + 1 < args.length && !args[i + 1].startsWith('--') && idPattern.test(args[i + 1])) selectedLanes.add(args[++i]);
    else { process.stderr.write(`${usage}\n`); return 2; }
  }
  try {
    const report = await readStraySlots(readers, selectedLanes.size ? selectedLanes : undefined);
    const slotsLost = report.lanes.reduce((sum, lane) => sum + lane.slotsLost, 0);
    const summary = { slotsLost, selectedLanes: [...selectedLanes].sort().map(scrubSecrets), passed: slotsLost === 0 };
    const details = report.lanes.map(lane =>
      `${lane.lane}: ${lane.slotsLost} slots lost\n${lane.strays.map(p => `  ${p.job} pid=${p.pid} age=${p.ageSeconds ?? 'unknown'}s`).join('\n')}`).join('\n');
    console.log(json ? JSON.stringify(check ? { ...report, summary } : report) : check
      ? `${details}${details ? '\n' : ''}Observed ${slotsLost} lost slot(s): ${summary.passed ? 'PASS' : 'FAIL'}.\nNo matching jobs means no observed stray slots, not proof a provider is available.`
      : details);
    return check && slotsLost > 0 ? 1 : 0;
  } catch {
    process.stderr.write('error: fleet stray-slots unavailable\n'); return 1;
  }
}
