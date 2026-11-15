import { EventEmitter } from 'node:events';
/**
 * Review finding d0 (3.10): sandbox-violation evidence must not come solely
 * from agent-controlled output. The kernel's own log of each TAGGED protected
 * denial is now the source of truth (kernel-evidence.ts); output parsing is a
 * secondary signal; and a run whose kernel evidence is unavailable or
 * incomplete reports its violations as UNKNOWN (violationsKnown=false), never
 * as "zero". The darwin block runs the real `log stream` + sandbox-exec (no
 * model, no seat, HOME is the per-worker temp home).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fileURLToPath } from 'node:url';
import {
  LOG_STREAM_SUPERVISOR_SH,
  attachLifetimeStop,
  isViolationTag,
  logStreamArgv,
  newViolationTag,
  parseKernelDenials,
  startSandboxDenialWatch,
  stopLogStream,
  type KernelEvidenceDeps,
} from '../src/core/sandbox/kernel-evidence.js';
import {
  AUTONOMOUS_DENIED_EXECUTABLES,
  autonomousConfinementProfile,
  buildAutonomousSbplProfile,
  sandboxViolationsFromKernel,
} from '../src/core/sandbox/confine.js';
import { buildAutonomousEnvOverlay } from '../src/core/sandbox/autonomous-env.js';
import {
  finishAutonomousSpawn,
  prepareAutonomousSpawn,
  setKernelEvidenceWatcherForTest,
  type AutonomousSpawn,
} from '../src/core/sandbox/autonomous-run.js';

afterEach(() => setKernelEvidenceWatcherForTest());

const DARWIN = process.platform === 'darwin';

function event(message: string): string {
  return JSON.stringify({ eventMessage: message, processImagePath: '/kernel', senderImagePath: '/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox' });
}

describe('parseKernelDenials (d0)', () => {
  const tag = newViolationTag();
  it('extracts tagged denials (engine or child), the barrier, and dropped-message warnings', () => {
    const capture = [
      `Filtering the log data using "sender == "Sandbox" AND composedMessage CONTAINS "${tag}""`,
      event(`Sandbox: cat(90303) deny(1) file-read-data /Users/m/.ashlr/authority/grant.json\n${tag}`),
      event(`2 duplicate reports for Sandbox: bash(90304) deny(1) process-exec* /usr/bin/security\n${tag}`),
      event(`Sandbox: cat(1) deny(1) file-read-data /other\nashlr-sbx-${'0'.repeat(32)}`), // another run's tag
      event(`Sandbox: cat(2) deny(1) file-read-data /tmp/x/barrier\n${tag}-end`),
    ].join('\n');
    const parsed = parseKernelDenials(capture, tag);
    expect(parsed.barrier).toBe(true);
    expect(parsed.dropped).toBe(false);
    expect(parsed.denials).toEqual([
      { process: 'cat', pid: 90303, operation: 'file-read-data', target: '/Users/m/.ashlr/authority/grant.json' },
      { process: 'bash', pid: 90304, operation: 'process-exec*', target: '/usr/bin/security' },
    ]);
    expect(parseKernelDenials(`${capture}\n=== Messages dropped during live streaming (use \`log show\` to see what they were)`, tag).dropped).toBe(true);
  });

  it('tags are unguessable hex (safe in SBPL and log predicates)', () => {
    const a = newViolationTag();
    expect(isViolationTag(a)).toBe(true);
    expect(a).not.toBe(newViolationTag());
    expect(isViolationTag('ashlr-sbx-"; (allow default)')).toBe(false);
  });
});


describe('log-stream supervisor packaging (WEYV-SANDBOX-LOGSTREAM-sec)', () => {
  const supervisorPath = fileURLToPath(new URL('../src/core/sandbox/log-stream-supervisor.sh', import.meta.url));

  it('embeds the canonical supervisor script verbatim (trailing newline aside)', () => {
    const fromFile = readFileSync(supervisorPath, 'utf8').replace(/(?:\r?\n)$/, '');
    expect(fromFile).toBe(LOG_STREAM_SUPERVISOR_SH);
  });

  it('ships the supervisor script as an executable file', () => {
    const mode = statSync(supervisorPath).mode;
    expect(mode & 0o111).toBeTruthy();
  });

  it('preserves the historical log stream argv', () => {
    const predicate = 'sender == "Sandbox" AND eventMessage CONTAINS "ashlr-sbx-0123456789abcdef0123456789abcdef"';
    expect(logStreamArgv(predicate)).toEqual(['stream', '--style', 'ndjson', '--predicate', predicate]);
  });

  it('attachLifetimeStop installs SIGTERM/SIGINT/SIGHUP/exit hooks and detach removes them', () => {
    const before = {
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGINT: process.listenerCount('SIGINT'),
      SIGHUP: process.listenerCount('SIGHUP'),
      exit: process.listenerCount('exit'),
    };
    let calls = 0;
    const detach = attachLifetimeStop(() => { calls += 1; });
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT + 1);
    expect(process.listenerCount('SIGHUP')).toBe(before.SIGHUP + 1);
    expect(process.listenerCount('exit')).toBe(before.exit + 1);
    detach();
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
    expect(process.listenerCount('SIGHUP')).toBe(before.SIGHUP);
    expect(process.listenerCount('exit')).toBe(before.exit);
    expect(calls).toBe(0);
  });

  it('stopLogStream sends SIGTERM then SIGKILL after grace if the process is still alive', async () => {
    // Ignore TERM from the first instruction (no race with a shell trap), then
    // announce readiness so we do not signal before SIG_IGN is installed.
    const child = spawn('/usr/bin/python3', ['-c',
      'import signal,sys,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); sys.stdout.write("r"); sys.stdout.flush(); time.sleep(30)',
    ], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = child.pid;
    expect(pid).toBeGreaterThan(1);
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('child never became ready')), 2000);
        const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
          clearTimeout(t);
          reject(new Error(`child exited before ready: ${sig ?? code}`));
        };
        child.stdout!.once('data', () => {
          clearTimeout(t);
          child.off('exit', onExit);
          resolve();
        });
        child.once('exit', onExit);
      });
      const stream = {
        pid,
        kill(signal?: NodeJS.Signals) {
          try { process.kill(pid!, signal); return true; } catch { return false; }
        },
      };
      stopLogStream(stream, 200);
      // kill(pid, 0) still succeeds on a zombie; wait for the handle to reap it.
      const signal = await new Promise<NodeJS.Signals | number | null>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`child ${pid} still running after stopLogStream`)), 2000);
        child.once('exit', (code, sig) => {
          clearTimeout(t);
          resolve(sig ?? code);
        });
      });
      expect(signal).toBe('SIGKILL');
    } finally {
      try { process.kill(-pid!, 'SIGKILL'); } catch { /* already gone */ }
      try { process.kill(pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
});

describe('startSandboxDenialWatch with injected process pieces (d0)', () => {
  function deps(opts: { ready?: boolean; lines?: (tag: string) => string[]; barrier?: boolean; platform?: NodeJS.Platform }): KernelEvidenceDeps & { killed: number } {
    let now = 0;
    let fd = -1;
    const d = {
      killed: 0,
      platform: opts.platform ?? 'darwin',
      startStream: (_predicate: string, outFd: number) => {
        fd = outFd;
        if (opts.ready !== false) writeFileSync(fd, 'Filtering the log data using "…"\n');
        return { kill: () => { d.killed++; return true; } };
      },
      barrier: (_marker: string, message: string) => {
        void fd;
        const tag = message.replace(/-end$/, '');
        const out = [...(opts.lines?.(tag) ?? []), ...(opts.barrier === false ? [] : [event(`Sandbox: cat(9) deny(1) file-read-data /b\n${message}`)])];
        captured.push(out.join('\n'));
      },
      sleepSync: (ms: number) => { now += ms; },
      nowMs: () => now,
    };
    const captured: string[] = [];
    // The stream writes to the capture file; emulate by appending on barrier.
    const realBarrier = d.barrier;
    d.barrier = (marker, message) => {
      realBarrier(marker, message);
      const file = join(marker, '..', 'stream.ndjson');
      writeFileSync(file, `Filtering the log data using "…"\n${captured.join('\n')}\n`, { flag: 'w' });
    };
    return d;
  }

  it('complete: tagged denials returned after the barrier; the stream is stopped', () => {
    const d = deps({ lines: (tag) => [event(`Sandbox: sh(5) deny(1) process-exec* /usr/bin/security\n${tag}`)] });
    const watch = startSandboxDenialWatch(newViolationTag(), { deps: d });
    const evidence = watch.finish();
    expect(evidence.state).toBe('complete');
    expect(evidence.denials.map((x) => x.target)).toEqual(['/usr/bin/security']);
    expect(d.killed).toBe(1);
    expect(watch.finish()).toBe(evidence); // idempotent
  });

  it.each(['exit', 'error', 'close'])('readiness drops if a started stream emits %s before completion', eventName => {
    const d=deps({});const original=d.startStream;const child=new EventEmitter();
    d.startStream=(predicate,fd)=>{const inert=original(predicate,fd);return Object.assign(child,{kill:inert.kill.bind(inert)});};
    const watch=startSandboxDenialWatch(newViolationTag(),{deps:d});expect(watch.ready).toBe(true);
    child.emit(eventName,...(eventName==='error'?[new Error('fixture stream failed')]:[]));
    expect(watch.ready).toBe(false);watch.abort();expect(watch.ready).toBe(false);
  });

  it('a stream that never becomes ready ⇒ unavailable (violations unknown, never "zero")', () => {
    const d = deps({ ready: false });
    const evidence = startSandboxDenialWatch(newViolationTag(), { deps: d }).finish();
    expect(evidence.state).toBe('unavailable');
    expect(evidence.denials).toEqual([]);
  });

  it('no barrier ⇒ incomplete; not macOS ⇒ unavailable; an invalid tag ⇒ unavailable', () => {
    expect(startSandboxDenialWatch(newViolationTag(), { deps: deps({ barrier: false }) }).finish().state).toBe('incomplete');
    expect(startSandboxDenialWatch(newViolationTag(), { deps: deps({ platform: 'linux' }) }).finish().state).toBe('unavailable');
    expect(startSandboxDenialWatch('not-a-tag', { deps: deps({}) }).finish().state).toBe('unavailable');
  });
});

describe('the SBPL profile tags exactly the violation rules (d0)', () => {
  function world() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'd0-profile-')));
    const home = join(root, 'home');
    const worktree = join(home, '.ashlr', 'sandboxes', 'sb1');
    const run = join(root, 'run');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(run, { mode: 0o700 });
    const overlay = buildAutonomousEnvOverlay({ engine: 'local', runTmpDir: run, home, seatId: null, path: '/usr/bin:/bin' });
    return { home, worktree, overlay };
  }

  it('tripwires, the custody helper and escape-tool execs carry the tag; quiet denials do not', () => {
    const w = world();
    const tag = newViolationTag();
    const p = buildAutonomousSbplProfile(autonomousConfinementProfile('local'), { worktree: w.worktree, home: w.home, overlay: w.overlay, violationTag: tag });
    const tagged = p.split('\n').filter((l) => l.includes(tag));
    expect(tagged.some((l) => l.includes('(with send-signal SIGKILL)') && l.includes('.ashlr/authority'))).toBe(true);
    expect(tagged.some((l) => l.includes('ashlr-custody') && l.startsWith('(deny file-read-data'))).toBe(true);
    const taggedExec = tagged.find((l) => l.startsWith('(deny process-exec'))!;
    expect(taggedExec).toContain('/usr/bin/security');
    expect(taggedExec).not.toContain('/usr/bin/pbcopy');
    // Every denied executable is still denied (split, not dropped).
    for (const exe of AUTONOMOUS_DENIED_EXECUTABLES) expect(p).toContain(`"${exe}"`);
    expect(tagged.every((l) => !l.startsWith('(deny mach-lookup') && !l.startsWith('(deny file-read* (subpath'))).toBe(true);
  });

  it('an invalid or absent tag leaves the rules untagged', () => {
    const w = world();
    const p = buildAutonomousSbplProfile(autonomousConfinementProfile('local'), { worktree: w.worktree, home: w.home, overlay: w.overlay, violationTag: 'x") (allow default' });
    expect(p).not.toContain('with message');
  });

  it('kernel denials map onto the same operation strings as the output scan', () => {
    const home = '/Users/m';
    expect(sandboxViolationsFromKernel([
      { process: 'cat', operation: 'file-read-data', target: '/Users/m/.ashlr/authority/grant.json' },
      { process: 'cat', operation: 'file-read-data', target: '/Users/m/.ashlr/authority/ledger.jsonl' },
      { process: 'bash', operation: 'process-exec*', target: '/usr/bin/security' },
      { process: 'node', operation: 'file-write-create', target: '/Users/m/Library/Keychains/login.keychain-db' },
    ], home)).toEqual(['access ~/.ashlr/authority', 'access ~/Library/Keychains', 'exec /usr/bin/security']);
  });
});

describe('finishAutonomousSpawn: kernel evidence first, output second (d0)', () => {
  function fakeSpawn(evidence: AutonomousSpawn['evidence']): AutonomousSpawn {
    const runDir = realpathSync(mkdtempSync(join(tmpdir(), 'd0-run-')));
    return {
      bin: '/bin/sh', env: {}, launcher: { bin: '/usr/bin/sandbox-exec', prefixArgs: [] },
      overlay: { vendorCommits: [] } as unknown as AutonomousSpawn['overlay'],
      profile: { mode: 'os' }, runDir, home: '/Users/m', evidence,
    };
  }

  it('SILENT agent: output shows nothing, the kernel recorded the denial ⇒ it is a violation', () => {
    const tag = newViolationTag();
    const spawn = fakeSpawn({
      tag,
      finish: () => ({ source: 'kernel-log', state: 'complete', reason: null, denials: [{ process: 'cat', pid: 7, operation: 'file-read-data', target: '/Users/m/.ashlr/authority/grant.json' }] }),
      abort: () => undefined,
    });
    const finished = finishAutonomousSpawn(spawn, { output: '' });
    expect(finished.violations).toEqual(['access ~/.ashlr/authority']);
    expect(finished.violationsKnown).toBe(true);
  });

  it('no kernel evidence ⇒ violations UNKNOWN even when the output is clean', () => {
    const finished = finishAutonomousSpawn(fakeSpawn(null), { output: 'all good' });
    expect(finished.violations).toEqual([]);
    expect(finished.violationsKnown).toBe(false);
    expect(finished.kernelEvidence.state).toBe('unavailable');
  });

  it('output parsing stays a secondary signal (it can add, never remove)', () => {
    const spawn = fakeSpawn({ tag: newViolationTag(), finish: () => ({ source: 'kernel-log', state: 'complete', reason: null, denials: [] }), abort: () => undefined });
    const finished = finishAutonomousSpawn(spawn, { output: '/usr/bin/security: Operation not permitted' });
    expect(finished.violations).toEqual(['exec /usr/bin/security']);
  });
});

function kernelLogUsable(): boolean {
  if (!DARWIN) return false;
  const r = spawnSync('/usr/bin/log', ['stream', '--timeout', '1', '--predicate', 'sender == "ashlr-none"'], { encoding: 'utf8', timeout: 5_000 });
  return /Filtering the log data/.test(`${r.stdout}${r.stderr}`);
}

describe.runIf(kernelLogUsable())('REAL kernel evidence under sandbox-exec (d0, darwin)', () => {
  it('an agent that hides every denial (2>/dev/null, || true, child-only tripwire) is still caught', () => {
    setKernelEvidenceWatcherForTest((tag, parent) => startSandboxDenialWatch(tag, { parent }));
    const home = realpathSync(process.env.HOME!);
    const worktree = join(home, '.ashlr', 'sandboxes', 'd0-silent');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(home, '.ashlr', 'authority'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.ashlr', 'authority', 'grant.json'), '{}\n');
    const prep = prepareAutonomousSpawn({ engine: 'local', worktree, baseEnv: { PATH: '/usr/bin:/bin' }, bin: '/bin/sh' });
    expect(prep.evidence).not.toBeNull();
    const script = `{ /bin/cat "${home}/.ashlr/authority/grant.json"; /usr/bin/security find-generic-password -s ai.ashlr.custody; } >/dev/null 2>&1 || true; exit 0`;
    const r = spawnSync(prep.launcher.bin, [...prep.launcher.prefixArgs, '/bin/sh', '-c', script], { cwd: worktree, env: prep.env, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toBe(''); // nothing for the output scan to find
    const finished = finishAutonomousSpawn(prep, { output: `${r.stdout}${r.stderr}` });
    expect(finished.kernelEvidence.state).toBe('complete');
    expect(finished.violationsKnown).toBe(true);
    expect(finished.violations).toEqual(['access ~/.ashlr/authority', 'exec /usr/bin/security']);
  });

  it('a clean run is complete with zero violations (known zero, not unknown)', () => {
    setKernelEvidenceWatcherForTest((tag, parent) => startSandboxDenialWatch(tag, { parent }));
    const home = realpathSync(process.env.HOME!);
    const worktree = join(home, '.ashlr', 'sandboxes', 'd0-clean');
    mkdirSync(worktree, { recursive: true });
    const prep = prepareAutonomousSpawn({ engine: 'local', worktree, baseEnv: { PATH: '/usr/bin:/bin' }, bin: '/bin/sh' });
    const r = spawnSync(prep.launcher.bin, [...prep.launcher.prefixArgs, '/bin/sh', '-c', 'echo ok > out.txt'], { cwd: worktree, env: prep.env, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(0);
    const finished = finishAutonomousSpawn(prep, { output: r.stdout });
    expect(finished.kernelEvidence.state).toBe('complete');
    expect(finished.violations).toEqual([]);
    expect(finished.violationsKnown).toBe(true);
  });
});
