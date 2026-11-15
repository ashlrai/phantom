/**
 * core/memory/system-deps.ts -- real machine effects for `phm mem reclaim`.
 *
 * Everything here is small and boring on purpose: the safety rules live in
 * reclaim.ts, this file only reads the process table, reads the queue status
 * file, signals pids and asks vmmap for swap totals. Nothing in this file
 * reads auth material, writes files, or opens sockets.
 */

import { execFile, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OMLX_BASE_URL,
  DEFAULT_RECLAIM_OPTIONS,
  PROCESS_TABLE_ARGS,
  parseProcessTable,
  parseQueueStatusJson,
  type ProcessRow,
  type QueueStatusView,
  type ReclaimDeps,
  type ReclaimPlanOptions,
} from './reclaim.js';

const PS_TIMEOUT_MS = 10_000;
/** A busy table is a few hundred KB; headroom beats a silent truncation. */
const PS_MAX_BUFFER = 16 * 1024 * 1024;
const VMMAP_TIMEOUT_MS = 2_000;

/** Default router queue snapshots, most specific first. */
export function defaultQueueStatusPaths(home: string = homedir()): string[] {
  return [
    join(home, '.ashlr-runs', 'queue', 'status.json'),
    join(home, '.ashlr-runs', 'queue', 'queue.v1.json'),
  ];
}

function runPsAsync(args: string[]): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile('/bin/ps', args, { encoding: 'utf8', timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER }, (err, stdout) => {
        resolve(err || typeof stdout !== 'string' ? null : stdout);
      });
    } catch {
      resolve(null);
    }
  });
}

function processIsZombie(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'state='], { encoding: 'utf8', timeout: 5_000 });
    if (result.status !== 0 || typeof result.stdout !== 'string') return false;
    return result.stdout.trim().startsWith('Z');
  } catch {
    return false;
  }
}

/**
 * Read the first readable queue snapshot from `paths`. ENOENT on every path
 * means no queue exists (state 'missing'); a present-but-unreadable or
 * unparseable file fails closed (state 'invalid').
 */
export async function readQueueStatusFrom(paths: readonly string[]): Promise<QueueStatusView> {
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      // EACCES and friends: the file exists but we cannot see inside. Fail
      // closed, never treat "cannot read" as "no live jobs".
      return { state: 'invalid', path, jobs: [], liveJobPids: new Set(), finishedJobPids: new Map() };
    }
    if (text.length > 32 * 1024 * 1024) {
      return { state: 'invalid', path, jobs: [], liveJobPids: new Set(), finishedJobPids: new Map() };
    }
    try {
      return parseQueueStatusJson(JSON.parse(text), path);
    } catch {
      return { state: 'invalid', path, jobs: [], liveJobPids: new Set(), finishedJobPids: new Map() };
    }
  }
  return { state: 'missing', path: paths[0] ?? null, jobs: [], liveJobPids: new Set(), finishedJobPids: new Map() };
}

function runVmmap(pid: number): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(
        '/usr/bin/vmmap',
        ['-summary', '--interleaveContent', '0', String(pid)],
        { encoding: 'utf8', timeout: VMMAP_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (err, stdout) => resolve(err || typeof stdout !== 'string' ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });
}

const SIZE_UNITS: Record<string, number> = { K: 1, M: 1024, G: 1024 * 1024, T: 1024 * 1024 * 1024 };

/** Tolerant `swapped out` total from `vmmap -summary`; null when absent. */
export function swappedOutKb(vmmapSummary: string | null): number | null {
  if (vmmapSummary === null) return null;
  const m = /swapped\s*out\s*[:=]?\s*([\d.]+)\s*([KMGT])i?B?/i.exec(vmmapSummary);
  if (!m) return null;
  const value = Number.parseFloat(m[1] as string);
  const unit = SIZE_UNITS[(m[2] as string).toUpperCase()];
  if (!Number.isFinite(value) || unit === undefined) return null;
  return Math.round(value * unit);
}

/**
 * Real deps for the CLI. `queueStatusPaths` defaults to the router queue
 * location; tests and `--queue-status` callers inject their own.
 */
export function realReclaimDeps(opts: { queueStatusPaths?: readonly string[] } = {}): ReclaimDeps {
  const paths = opts.queueStatusPaths ?? defaultQueueStatusPaths();
  return {
    readProcessTable: async (): Promise<ProcessRow[]> => {
      const out = await runPsAsync(PROCESS_TABLE_ARGS);
      return out === null ? [] : parseProcessTable(out);
    },
    readQueueStatus: () => readQueueStatusFrom(paths),
    fetchImpl: fetch,
    killPid: (pid, signal) => { process.kill(pid, signal); },
    pidAlive: (pid) => {
      if (!Number.isInteger(pid) || pid <= 1) return false;
      try {
        process.kill(pid, 0);
        return !processIsZombie(pid);
      } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === 'EPERM';
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    selfPid: process.pid,
    swapKb: async (pid) => swappedOutKb(await runVmmap(pid)),
  };
}

export function realPlanOptions(overrides: Partial<ReclaimPlanOptions> = {}): ReclaimPlanOptions {
  return { ...DEFAULT_RECLAIM_OPTIONS, ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL, omlxBaseUrl: DEFAULT_OMLX_BASE_URL, ...overrides };
}
