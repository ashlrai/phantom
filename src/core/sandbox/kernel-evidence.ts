/**
 * Kernel sandbox-denial evidence — V3.10 review finding d0.
 *
 * The rollout's "0 sandbox violations" criterion used to rest on two signals:
 * the engine's own output (sandboxViolationsInOutput) and a SIGKILL of the
 * ENGINE process. The agent under evaluation controls the first (`2>/dev/null`,
 * `|| true`, not echoing tool output) and dodges the second by letting only a
 * CHILD touch a tripwire. The source of truth now is the kernel's own record
 * of the denial, which the agent cannot suppress:
 *
 *   1. Every protected deny rule in the run's SBPL profile carries
 *      `(with message "<tag>")`, a per-run random tag (confine.ts). The kernel
 *      then logs each such denial as a `Sandbox` event whose message ends in
 *      the tag — for the engine AND every descendant, whatever they print.
 *   2. Before the engine starts, `log stream` is started with a predicate on
 *      exactly that tag, writing NDJSON to a private 0700 dir that the
 *      confined run can neither read nor write (it lives outside the run's
 *      writable set, and the temp dirs are read-jailed). Start-up blocks
 *      (bounded) until the stream prints its header, so a denial in the first
 *      millisecond of the run is not missed.
 *   3. After the engine exits, a BARRIER: one extra sandbox-exec denial tagged
 *      `<tag>-end`. Kernel events arrive in order, so seeing the barrier in the
 *      stream proves every earlier denial of this run has been delivered.
 *
 * Measured on macOS 26 (Darwin 25): ready ≈ 85 ms, barrier ≈ 40 ms. A
 * sandbox-exec denial is NOT persisted for `log show` afterwards (only the
 * live stream sees it) — which is why this streams for the run's lifetime
 * rather than querying the log after the fact.
 *
 * Honesty: `complete` only when the stream was ready before the run, the
 * barrier arrived, and the stream reported no dropped messages. Anything else
 * is `unavailable` / `incomplete` — violations UNKNOWN, never "zero".
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LOG_BINARY = '/usr/bin/log';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** Grace between SIGTERM and SIGKILL of the log-stream process group. */
export const LOG_STREAM_KILL_GRACE_MS = 500;
/**
 * Supervisor started as `/bin/sh -c SCRIPT $0 LOG_BIN ...argv`.
 * It puts the stream in the same process group and reaps the group if the
 * wrapper dies (including SIGKILL: ppid becomes 1). Prints nothing (the
 * capture fd is stdout/stderr). Canonical copy: src/log-stream-supervisor.sh.
 */
export const LOG_STREAM_SUPERVISOR_SH = String.raw`# ashlr-log-stream-supervisor. Invoked as:
#   /bin/sh -c SCRIPT ashlr-log-stream-supervisor LOG_BIN stream --style ndjson --predicate PREDICATE
# $1 is LOG_BIN; remaining args are passed through unchanged. The caller
# starts this in its own process group. Stdout and stderr are the capture
# fd: print nothing. If the parent dies (SIGKILL of the wrapper), this
# script notices via kill -0 / ppid and TERM-then-KILL the group.
logbin=$1
shift
[ -n "$logbin" ] || exit 2
"$logbin" "$@" &
child=$!
parent=$PPID
pgid=$$
cleaning=0
cleanup() {
  [ "$cleaning" = 1 ] && return 0
  cleaning=1
  trap '' TERM INT HUP
  kill -TERM "$child" 2>/dev/null
  kill -TERM -"$pgid" 2>/dev/null
  i=0
  while [ "$i" -lt 10 ]; do
    kill -0 "$child" 2>/dev/null || break
    sleep 0.05
    i=$((i + 1))
  done
  kill -KILL "$child" 2>/dev/null
  wait "$child" 2>/dev/null
  # SIGKILL the rest of the group last (this process may die here).
  kill -KILL -"$pgid" 2>/dev/null
  exit 1
}
trap 'cleanup' TERM INT HUP
while :; do
  if ! kill -0 "$parent" 2>/dev/null; then
    cleanup
  fi
  cur=$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')
  if [ "$cur" = "1" ]; then
    cleanup
  fi
  if ! kill -0 "$child" 2>/dev/null; then
    wait "$child"
    rc=$?
    trap '' TERM INT HUP
    exit "$rc"
  fi
  sleep 0.2
done`;
/** Longest the daemon blocks for the stream to come up before the run starts. */
export const STREAM_READY_TIMEOUT_MS = 3_000;
/** Longest it waits for the end barrier after the run. */
export const BARRIER_TIMEOUT_MS = 3_000;
const POLL_MS = 10;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

const TAG_RE = /^ashlr-sbx-[0-9a-f]{32}$/;

/** A fresh, unguessable per-run tag (hex only: safe inside SBPL strings and log predicates). */
export function newViolationTag(): string {
  return `ashlr-sbx-${randomBytes(16).toString('hex')}`;
}

export function isViolationTag(value: unknown): value is string {
  return typeof value === 'string' && TAG_RE.test(value);
}

export interface KernelDenial {
  /** Process name as the kernel reported it (`cat`, `bash`, `node`). */
  process: string;
  pid: number | null;
  /** SBPL operation, e.g. `file-read-data`, `process-exec*`, `mach-lookup`. */
  operation: string;
  /** Path / service name; '' when the event names none. */
  target: string;
}

export interface KernelEvidence {
  source: 'kernel-log';
  /**
   * complete    — every tagged denial of the run was observed (possibly none).
   * incomplete  — the stream ran, but the barrier never arrived or messages were dropped.
   * unavailable — no stream (not macOS, no `log`, not permitted, never ready, disabled).
   */
  state: 'complete' | 'incomplete' | 'unavailable';
  /** Why it is not complete; null when complete. Plain sentence, no paths. */
  reason: string | null;
  denials: KernelDenial[];
}

export interface SandboxDenialWatch {
  readonly tag: string;
  /** True only after the kernel stream starts; completion still needs its barrier. */
  readonly ready?: boolean;
  /** Stop the stream (after the barrier) and return what the kernel reported. Idempotent; never throws. */
  finish(): KernelEvidence;
  /** Stop without collecting (a run that never started). Idempotent. */
  abort(): void;
}

/** Injection seam: the process pieces, so tests never start a real `log stream`. */
export interface KernelEvidenceDeps {
  platform: NodeJS.Platform;
  startStream(predicate: string, outFd: number): ChildProcess | { kill(signal?: NodeJS.Signals): boolean; unref?(): void };
  /** Trigger the end barrier: a sandboxed read of `markerPath` denied with message `message`. */
  barrier(markerPath: string, message: string): void;
  sleepSync(ms: number): void;
  nowMs(): number;
}

function sleepSyncDefault(ms: number): void {
  // Blocks only this thread; the stream writes to a FILE, so no event-loop
  // turn is needed to observe its progress.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}


/** Exact argv production `log stream` has always used. */
export function logStreamArgv(predicate: string): string[] {
  return ['stream', '--style', 'ndjson', '--predicate', predicate];
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* already gone, or not a group leader */ }
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

/**
 * Start `/usr/bin/log stream` under a supervisor in its own process group.
 * The supervisor is the group leader (spawn detached). `unref` keeps the
 * event loop from staying open; cleanup is guaranteed by stop() / lifetime
 * handlers / the supervisor's parent-death check.
 */
export function startLogStreamWithSupervisor(
  predicate: string,
  outFd: number,
  logBin: string = LOG_BINARY,
): ChildProcess {
  const child = spawn('/bin/sh', ['-c', LOG_STREAM_SUPERVISOR_SH, 'ashlr-log-stream-supervisor', logBin, ...logStreamArgv(predicate)], {
    stdio: ['ignore', outFd, outFd],
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    detached: true,
  });
  child.on('error', () => { /* surfaces as "never ready" */ });
  child.unref();
  return child;
}

/** TERM the stream (and its group when pid is real), then KILL after a short grace. */
export function stopLogStream(
  stream: { kill(signal?: NodeJS.Signals): boolean; pid?: number } | null,
  graceMs: number = LOG_STREAM_KILL_GRACE_MS,
  sleepSync: (ms: number) => void = sleepSyncDefault,
): void {
  if (!stream) return;
  try { stream.kill('SIGTERM'); } catch { /* already gone */ }
  const pid = stream.pid;
  if (pid == null || pid <= 1) return;
  killProcessGroup(pid, 'SIGTERM');
  const until = Date.now() + graceMs;
  while (Date.now() < until) {
    let alive = false;
    try { process.kill(-pid, 0); alive = true; } catch {
      try { process.kill(pid, 0); alive = true; } catch { /* gone */ }
    }
    if (!alive) return;
    const slice = Math.min(50, Math.max(0, until - Date.now()));
    if (slice <= 0) break;
    sleepSync(slice);
  }
  killProcessGroup(pid, 'SIGKILL');
}

/**
 * On SIGTERM/SIGINT/SIGHUP/exit of the wrapper, stop the stream group.
 * Does not install uncaughtException (that would swallow the crash).
 * Only used when a real child pid exists. Returns a detach function.
 */
export function attachLifetimeStop(stopFn: () => void): () => void {
  let active = true;
  const run = (): void => {
    if (!active) return;
    active = false;
    detach();
    stopFn();
  };
  const onSig = (sig: NodeJS.Signals): void => {
    run();
    try { process.kill(process.pid, sig); } catch { /* exiting */ }
  };
  const onExit = (): void => { run(); };
  function detach(): void {
    process.removeListener('SIGTERM', onSig);
    process.removeListener('SIGINT', onSig);
    process.removeListener('SIGHUP', onSig);
    process.removeListener('exit', onExit);
  }
  process.on('SIGTERM', onSig);
  process.on('SIGINT', onSig);
  process.on('SIGHUP', onSig);
  process.on('exit', onExit);
  return () => { active = false; detach(); };
}

export const defaultKernelEvidenceDeps: KernelEvidenceDeps = {
  platform: process.platform,
  startStream: (predicate, outFd) => startLogStreamWithSupervisor(predicate, outFd),
  barrier: (markerPath, message) => {
    spawnSync(SANDBOX_EXEC, [
      '-p',
      `(version 1)(allow default)(deny file-read* (with message "${message}") (literal "${markerPath.replace(/["\\]/g, '')}"))`,
      '/bin/cat',
      markerPath,
    ], { stdio: 'ignore', timeout: 5_000, env: { PATH: '/usr/bin:/bin' } });
  },
  sleepSync: sleepSyncDefault,
  nowMs: () => Date.now(),
};

function readCapped(path: string): string {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length > MAX_EVIDENCE_BYTES ? text.slice(0, MAX_EVIDENCE_BYTES) : text;
  } catch {
    return '';
  }
}

const DENIAL_RE = /Sandbox:\s+(.+?)\((\d+)\)\s+deny\(\d+\)\s+(\S+)\s*([^\n]*)/;

/** PURE: the tagged denials in a `log stream --style ndjson` capture. */
export function parseKernelDenials(capture: string, tag: string): { denials: KernelDenial[]; barrier: boolean; dropped: boolean } {
  const denials: KernelDenial[] = [];
  let barrier = false;
  let dropped = false;
  const endMarker = `${tag}-end`;
  for (const raw of capture.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('{')) {
      if (/dropped/i.test(line)) dropped = true;
      continue;
    }
    let message: unknown;
    try {
      message = (JSON.parse(line) as { eventMessage?: unknown }).eventMessage;
    } catch {
      continue;
    }
    if (typeof message !== 'string' || !message.includes(tag)) continue;
    if (message.includes(endMarker)) {
      barrier = true;
      continue;
    }
    const match = DENIAL_RE.exec(message);
    if (!match) continue;
    const target = (match[4] ?? '').trim();
    denials.push({
      process: match[1]!.slice(0, 64),
      pid: Number.isSafeInteger(Number(match[2])) ? Number(match[2]) : null,
      operation: match[3]!.slice(0, 64),
      // The tag rides on the next line of the same event; never part of the target.
      target: target.includes(tag) ? '' : target.slice(0, 512),
    });
  }
  return { denials, barrier, dropped };
}

const unavailable = (reason: string): KernelEvidence => ({ source: 'kernel-log', state: 'unavailable', reason, denials: [] });

/**
 * Start watching the kernel for this run's tagged denials. Blocks (≤
 * STREAM_READY_TIMEOUT_MS) until the stream is live. Never throws: a watch
 * that could not start returns `unavailable` from finish().
 */
export function startSandboxDenialWatch(
  tag: string,
  options: { parent?: string; deps?: KernelEvidenceDeps } = {},
): SandboxDenialWatch {
  const deps = options.deps ?? defaultKernelEvidenceDeps;
  let done: KernelEvidence | null = null;
  const inert = (reason: string): SandboxDenialWatch => ({
    tag, ready: false,
    finish: () => (done ??= unavailable(reason)),
    abort: () => { done ??= unavailable(reason); },
  });
  if (!isViolationTag(tag)) return inert('the run has no valid violation tag');
  if (deps.platform !== 'darwin') return inert(`no kernel sandbox log on ${deps.platform}`);

  let dir: string;
  try {
    dir = realpathSync(mkdtempSync(join(realpathSync(options.parent ?? tmpdir()), 'ashlr-sbxlog-')));
  } catch {
    return inert('the private evidence directory could not be created');
  }
  const capture = join(dir, 'stream.ndjson');
  const cleanup = (): void => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  let stream: ReturnType<KernelEvidenceDeps['startStream']> | null = null;
  let streamUnavailable = false;
  try {
    const fd = openSync(capture, 'wx', 0o600);
    try {
      stream = deps.startStream(`sender == "Sandbox" AND eventMessage CONTAINS "${tag}"`, fd);
      const observable = stream as { once?: (event: string, listener: () => void) => unknown };
      if (typeof observable.once === 'function') {
        for (const event of ['error', 'exit', 'close']) observable.once(event, () => { streamUnavailable = true; });
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    cleanup();
    return inert('`log stream` could not be started');
  }
  let detachLifetime: (() => void) | null = null;
  const stop = (): void => {
    if (detachLifetime) {
      const d = detachLifetime;
      detachLifetime = null;
      d();
    }
    const current = stream;
    stream = null;
    stopLogStream(current);
  };
  const startedPid = (stream as { pid?: number } | null)?.pid;
  if (startedPid != null && startedPid > 1) {
    detachLifetime = attachLifetimeStop(stop);
  }

  // Ready = the stream printed its "Filtering the log data…" header.
  const readyBy = deps.nowMs() + STREAM_READY_TIMEOUT_MS;
  let ready = false;
  for (;;) {
    if (/Filtering the log data/.test(readCapped(capture))) { ready = true; break; }
    if (deps.nowMs() >= readyBy) break;
    deps.sleepSync(POLL_MS);
  }
  if (!ready) {
    const head = readCapped(capture).slice(0, 200);
    stop();
    cleanup();
    // e.g. "log: Must be admin to run 'stream' command" on a standard account.
    return inert(/admin|permission|not permitted/i.test(head)
      ? 'the kernel log stream is not permitted for this user'
      : 'the kernel log stream did not start in time');
  }

  return {
    tag,
    get ready() {
      const observed = stream as { exitCode?: number | null; signalCode?: NodeJS.Signals | null } | null;
      return done === null && stream !== null && !streamUnavailable && observed?.exitCode == null && observed?.signalCode == null;
    },
    finish(): KernelEvidence {
      if (done) return done;
      try {
        const marker = join(dir, 'barrier');
        try {
          writeFileSync(marker, 'b\n', { mode: 0o600 });
          deps.barrier(marker, `${tag}-end`);
        } catch { /* no barrier ⇒ incomplete below */ }
        const until = deps.nowMs() + BARRIER_TIMEOUT_MS;
        let parsed = parseKernelDenials(readCapped(capture), tag);
        while (!parsed.barrier && deps.nowMs() < until) {
          deps.sleepSync(POLL_MS);
          parsed = parseKernelDenials(readCapped(capture), tag);
        }
        const reason = !parsed.barrier
          ? 'the end-of-run barrier never reached the kernel log stream'
          : parsed.dropped ? 'the kernel log stream dropped messages during the run' : null;
        done = { source: 'kernel-log', state: reason ? 'incomplete' : 'complete', reason, denials: parsed.denials };
      } catch {
        done = { source: 'kernel-log', state: 'incomplete', reason: 'the kernel evidence could not be read', denials: [] };
      } finally {
        stop();
        cleanup();
      }
      return done;
    },
    abort(): void {
      if (done) return;
      done = unavailable('the run was aborted before it started');
      stop();
      cleanup();
    },
  };
}
