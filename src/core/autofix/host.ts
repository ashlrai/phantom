/**
 * In-memory host for tests, and the path guard shared with the node host.
 * System calls stay behind AutofixHost.exec so a test never touches launchd.
 */
import { REFUSED_EXEC, assertAllowedPath, forbiddenPath, isForbiddenExecArgv } from './guard.js';
import type { AutofixHost, ExecResult } from './types.js';

export interface MemoryHost extends AutofixHost {
  calls: string[][];
  writes: string[];
  files: Map<string, string>;
  mtimes: Map<string, number>;
  dirs: Map<string, string[]>;
  onExec: (argv: readonly string[]) => ExecResult;
}

export interface MemoryHostOptions {
  now?: Date;
  uid?: number;
  runsDir?: string;
  homeDir?: string;
  killPath?: string;
}

export function createMemoryHost(opts: MemoryHostOptions = {}): MemoryHost {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const dirs = new Map<string, string[]>();
  const calls: string[][] = [];
  const writes: string[] = [];
  const runsDir = opts.runsDir ?? '/tmp/autofix-runs';
  const homeDir = opts.homeDir ?? '/tmp/autofix-home';
  const kill = opts.killPath ?? `${homeDir}/.ashlr/KILL`;
  const now = opts.now ?? new Date('2026-11-16T18:00:00.000Z');
  const host: MemoryHost = {
    calls,
    writes,
    files,
    mtimes,
    dirs,
    now: () => now,
    uid: () => opts.uid ?? 501,
    runsDir: () => runsDir,
    homeDir: () => homeDir,
    killPath: () => kill,
    exists: (path) => !forbiddenPath(path) && files.has(path),
    readText: (path) => forbiddenPath(path) ? null : files.get(path) ?? null,
    writeFile: (path, text) => {
      assertAllowedPath(path);
      writes.push(path);
      files.set(path, text);
    },
    appendFile: (path, text) => {
      assertAllowedPath(path);
      writes.push(path);
      files.set(path, `${files.get(path) ?? ''}${text}`);
    },
    unlink: (path) => {
      assertAllowedPath(path);
      files.delete(path);
    },
    statMtime: (path) => forbiddenPath(path) ? null : mtimes.get(path) ?? null,
    listDir: (path) => forbiddenPath(path) ? [] : dirs.get(path) ?? [],
    onExec: () => ({ code: 0, stdout: '', stderr: '' }),
    exec: (argv) => {
      calls.push([...argv]);
      if (isForbiddenExecArgv(argv)) {
        return { ...REFUSED_EXEC };
      }
      return host.onExec(argv);
    },
    restartLanePool: (lane) => {
      calls.push(['restart-lane-pool', lane]);
      return Promise.resolve({ beforeTarget: 4, afterTarget: 4 });
    },
  };
  return host;
}
