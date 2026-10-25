/**
 * The pinned git supervisor (src/core/sandbox/worktree.ts) as the sandbox
 * creation runner uses it: started ahead of its command, handed exactly one
 * command over IPC, and never outliving its runner.
 *
 *  - a '.' command whose working-directory inode no longer matches the pin is
 *    refused before git starts;
 *  - a malformed command is refused;
 *  - an idle supervisor exits when its runner dies;
 *  - a supervisor whose runner dies while git runs kills git's tree first;
 *  - a REGISTER that fails and rolls back leaves no supervisor (or anything
 *    else it started) alive.
 *
 * REAL-IO: real Node supervisors and real git through a PATH shim under an
 * isolated tmp HOME. POSIX only (shell shims, process groups); the process
 * state checks read /proc and skip where it is missing. PID 1 in some
 * containers does not reap orphans, so a zombie counts as gone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { makeFixture, type DisposableRepo, type H1Fixture } from './helpers/h1-fixture.js';
import { _pinnedGitSupervisorSourceForTest, createSandbox, listSandboxes } from '../src/core/sandbox/worktree.js';

const posix = process.platform !== 'win32';
const hasProc = existsSync('/proc/self/stat');
const TIMEOUT = 30_000;

let dir: string;
let shimDir: string;
let prevPath: string | undefined;
const started: number[] = [];

function procState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? null;
  } catch {
    return null;
  }
}

function gone(pid: number): boolean {
  const state = procState(pid);
  return state === null || state === 'Z' || state === 'X';
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function installGitShim(body: string[]): void {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const script = join(shimDir, 'git');
  writeFileSync(script, ['#!/bin/sh', ...body.map((l) => l.replace('$REAL_GIT', realGit)), ''].join('\n'));
  chmodSync(script, 0o755);
  process.env.PATH = `${shimDir}${delimiter}${prevPath ?? ''}`;
}

/** A supervisor started the way the runner starts one: detached, IPC only. */
function startSupervisor(cwd: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', _pinnedGitSupervisorSourceForTest()], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    detached: true,
  });
  if (child.pid) started.push(child.pid);
  return child;
}

function resultOf(child: ChildProcess, command: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    child.once('message', (m) => resolve(m as Record<string, unknown>));
    child.once('error', reject);
    child.send(command as object);
  });
}

/**
 * A stand-in runner that starts one supervisor, prints its pid and, with
 * `command`, hands it a command (git in `cwd`), then idles until killed.
 */
function startRunner(cwd: string, withCommand: boolean): Promise<{ runner: ChildProcess; supervisorPid: number }> {
  const script = [
    "const { spawn } = require('node:child_process');",
    'const [source, cwd, withCommand] = process.argv.slice(1);',
    "const s = spawn(process.execPath, ['-e', source], { cwd, env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true });",
    "process.stdout.write(String(s.pid) + '\\n');",
    "if (withCommand === '1') s.send({ argv: [cwd, 'plain', '', 'status'], env: {}, cwdPin: null });",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const runner = spawn(process.execPath, ['-e', script, '--', _pinnedGitSupervisorSourceForTest(), cwd, withCommand ? '1' : '0'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    runner.stdout!.on('data', (chunk) => {
      out += String(chunk);
      if (out.includes('\n')) {
        const supervisorPid = Number(out.trim());
        started.push(supervisorPid);
        resolve({ runner, supervisorPid });
      }
    });
    runner.once('error', reject);
  });
}

beforeEach(() => {
  prevPath = process.env.PATH;
  dir = mkdtempSync(join(tmpdir(), 'ashlr-supervisor-'));
  shimDir = join(dir, 'shim');
  mkdirSync(shimDir);
});

afterEach(() => {
  process.env.PATH = prevPath;
  for (const pid of started.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)('pinned git supervisor commands', () => {
  it('refuses a "." command whose working-directory inode was replaced, before git starts', async () => {
    const marker = join(dir, 'git-started');
    installGitShim([`touch "${marker}"`, 'exec "$REAL_GIT" "$@"']);
    const pinned = join(dir, 'pinned');
    mkdirSync(pinned);
    const stat = lstatSync(pinned, { bigint: true });
    // The pinned directory moves away and another takes its path.
    renameSync(pinned, join(dir, 'pinned.old'));
    mkdirSync(pinned);

    const supervisor = startSupervisor(dir);
    const result = await resultOf(supervisor, {
      argv: ['.', 'plain', '', 'rev-parse', '--git-dir'],
      env: {},
      cwdPin: { path: pinned, dev: String(stat.dev), ino: String(stat.ino) },
    });
    expect(result).toMatchObject({ status: null });
    expect(String(result.error)).toMatch(/working directory identity changed before git command/u);
    expect(existsSync(marker)).toBe(false);
  }, TIMEOUT);

  it('refuses a malformed command without starting git', async () => {
    const marker = join(dir, 'git-started');
    installGitShim([`touch "${marker}"`, 'exec "$REAL_GIT" "$@"']);
    const supervisor = startSupervisor(dir);
    const result = await resultOf(supervisor, {});
    expect(result).toMatchObject({ status: null });
    expect(String(result.error)).toMatch(/invalid git supervisor command/u);
    expect(existsSync(marker)).toBe(false);
  }, TIMEOUT);
});

describe.skipIf(!posix || !hasProc)('pinned git supervisors never outlive their runner', () => {
  it('an idle pre-started supervisor exits when its runner is SIGKILLed', async () => {
    const { runner, supervisorPid } = await startRunner(dir, false);
    await waitFor(() => procState(supervisorPid) !== null);
    expect(gone(supervisorPid)).toBe(false);
    runner.kill('SIGKILL');
    await waitFor(() => gone(supervisorPid));
  }, TIMEOUT);

  it('a supervisor whose runner dies while git runs kills git\'s tree and exits', async () => {
    const gitPidFile = join(dir, 'git-pid');
    // `git` here records its pid and then stands in for a long git command.
    installGitShim([`echo $$ > "${gitPidFile}"`, 'exec sleep 30']);
    const { runner, supervisorPid } = await startRunner(dir, true);
    await waitFor(() => existsSync(gitPidFile) && readFileSync(gitPidFile, 'utf8').trim() !== '');
    const gitPid = Number(readFileSync(gitPidFile, 'utf8').trim());
    expect(gone(gitPid)).toBe(false);
    runner.kill('SIGKILL');
    await waitFor(() => gone(gitPid) && gone(supervisorPid));
  }, TIMEOUT);
});

describe.skipIf(!posix || !hasProc)('a REGISTER that rolls back drains its supervisors', () => {
  let fx: H1Fixture;
  let repo: DisposableRepo;
  let prevAllow: string | undefined;
  let prevTag: string | undefined;
  beforeEach(() => {
    prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    prevTag = process.env.ASHLR_TEST_SUPERVISOR_TAG;
    process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
    fx = makeFixture();
    repo = fx.makeRepo();
  });
  afterEach(() => {
    if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
    if (prevTag === undefined) delete process.env.ASHLR_TEST_SUPERVISOR_TAG;
    else process.env.ASHLR_TEST_SUPERVISOR_TAG = prevTag;
    fx.cleanup();
  });

  /** Live (non-zombie) processes, other than this one, started with `tag` in their env. */
  function liveTagged(tag: string): number[] {
    const needle = `ASHLR_TEST_SUPERVISOR_TAG=${tag}`;
    return readdirSync('/proc').filter((e) => /^\d+$/u.test(e)).map(Number).filter((pid) => {
      if (pid === process.pid || gone(pid)) return false;
      try {
        return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(needle);
      } catch {
        return false;
      }
    });
  }

  it('leaves no supervisor or git process alive after a failed worktree add', () => {
    const tag = randomBytes(8).toString('hex');
    process.env.ASHLR_TEST_SUPERVISOR_TAG = tag;
    installGitShim([
      'if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then exit 1; fi',
      'exec "$REAL_GIT" "$@"',
    ]);
    expect(() => createSandbox(repo.dir, { allowAnyRepo: true })).toThrow(/git worktree add failed/u);
    expect(listSandboxes()).toEqual([]);
    expect(liveTagged(tag)).toEqual([]);
  }, TIMEOUT);
});
