/**
 * Host that talks to the local machine. Tests use createMemoryHost instead.
 * launchctl, gh, renice and `phm authority resident status` are the only
 * process calls. Pinned dispatcher files are never written.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { readLaneTargets, setLaneTarget } from '../fleet/runs-lane-targets.js';
import { forbiddenPath } from './guard.js';
import type { AutofixHost, ExecResult } from './types.js';

function runsRoot(): string {
  const fromEnv = process.env.ASHLR_RUNS_DIR;
  return fromEnv && fromEnv.startsWith('/') ? fromEnv : join(homedir(), '.ashlr-runs');
}

function safeStat(path: string): { mtimeMs: number } | null {
  if (forbiddenPath(path)) return null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function readRegular(path: string): string | null {
  if (forbiddenPath(path)) return null;
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally { closeSync(fd); }
}

function ensureDir(path: string): void {
  const stat = safeStat(path);
  if (stat) return;
  try {
    const current = lstatSync(path);
    if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('ledger path is not a directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

export function createNodeHost(now: () => Date = () => new Date()): AutofixHost {
  const runsDir = runsRoot();
  const home = homedir();
  return {
    now,
    uid: () => typeof process.getuid === 'function' ? process.getuid() : 501,
    runsDir: () => runsDir,
    homeDir: () => home,
    killPath: () => join(home, '.ashlr', 'KILL'),
    exists: (path) => safeStat(path) !== null,
    readText: (path) => readRegular(path),
    writeFile: (path, text) => {
      if (forbiddenPath(path)) throw new Error('refused path');
      ensureDir(dirname(path));
      const temp = `${path}.tmp-${process.pid}`;
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { writeSync(fd, text); } finally { closeSync(fd); }
      renameSync(temp, path);
    },
    appendFile: (path, text) => {
      if (forbiddenPath(path)) throw new Error('refused path');
      ensureDir(dirname(path));
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { writeSync(fd, text); } finally { closeSync(fd); }
    },
    unlink: (path) => {
      if (forbiddenPath(path)) throw new Error('refused path');
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('refused unlink');
      unlinkSync(path);
    },
    statMtime: (path) => safeStat(path)?.mtimeMs ?? null,
    listDir: (path) => {
      if (forbiddenPath(path)) return [];
      try {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
        return readdirSync(path);
      } catch { return []; }
    },
    exec: (argv) => execChecked(argv),
    restartLanePool: async (lane) => {
      const view = await readLaneTargets({ runsDir, changedBy: 'phm autofix' });
      const row = view.lanes.find((item) => item.lane === lane);
      if (!row || view.sourceState !== 'healthy') throw new Error('lane pool unavailable');
      await setLaneTarget(lane, row.target, { runsDir, changedBy: 'phm autofix' });
      return { beforeTarget: row.target, afterTarget: row.target };
    },
  };
}

function execChecked(argv: readonly string[]): ExecResult {
  if (argv.length === 0 || argv.some((arg) => forbiddenPath(arg) || /^(kill|pkill|killall)$/.test(arg))) {
    return { code: 1, stdout: '', stderr: 'refused' };
  }
  try {
    const stdout = execFileSync(argv[0]!, argv.slice(1), {
      encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.status === 'number' ? failed.status : 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}
