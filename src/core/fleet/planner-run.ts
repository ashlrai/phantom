/**
 * planner-run.ts — run ONE fleet planner pass on whichever login is live.
 *
 * The missing half of planner-failover.ts (#2222): nothing in src/ launched
 * the runner it picked — the hourly pass lived in a shell script outside the
 * repo, pinned to one Codex login and logging `LEADER codex rc=0` even when
 * codex had died. planPlannerPass files the newest health read under
 * `lastProvider` and picks the first non-limited candidate; runPlannerPass
 * spawns its argv (no shell), feeds the prompt file to stdin, captures
 * stdout+stderr to supervisor/run.<ISO>.log and appends ONE honest LEADER
 * row to queue/dispatch-events.log — `ok` on exit 0, `rc=<code>` from the
 * close event (never a shell $?) otherwise, `rc=124` on the timeout kill.
 * ORCH_OFF still gates the pass; argv and per-login env are caller data.
 * Never throws: every failure is a PlannerRunResult, with the scrubbed
 * reason left in the run log whenever one could be opened.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { appendFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { constants as osConstants, homedir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { scrubSecrets } from '../util/scrub.js';
import { readPlannerHealth, selectPlannerRunner, type PlannerCandidate, type PlannerHealth, type PlannerRunnerChoice } from './planner-failover.js';
import { readRunsSwitches } from './runs-switches.js';

export interface PlanOpts {
  /** Runs root holding queue/ and supervisor/; defaults to ~/.ashlr-runs. */
  runsRoot?: string;
  /** Runner candidates in the caller's priority order. */
  candidates: readonly PlannerCandidate[];
  /** Provider that produced the newest LEADER row — its health gates it. */
  lastProvider: string;
  now?: number;
}

export interface SpawnedPlannerProcess {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/** Spawn seam for tests; invoked with argv only — no shell, piped stdio. */
export type SpawnLike = (
  program: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; shell: false; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true },
) => SpawnedPlannerProcess;

export type RunPlannerPassOpts = PlanOpts & {
  /** Prompt file piped to the child's stdin (bounded read). */
  promptPath: string;
  /** Test seam; defaults to node:child_process spawn. */
  spawn?: SpawnLike;
  /** Per-login env overrides (CODEX_HOME etc.) merged over process.env. */
  env?: Record<string, string>;
  /** Kill the child past this; the pass is recorded rc=124. Default 20 min. */
  timeoutMs?: number;
};

export interface PlannerRunResult {
  v: 1;
  provider: string | null;
  outcome: 'ran' | 'skipped-orch-off' | 'no-runner' | 'spawn-failed';
  exitCode: number | null;
  logPath: string | null;
  startedAt: string;
  finishedAt: string;
  nextResetAt: string | null;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
const TOKEN_RUN = /[A-Za-z0-9_-]{20,}/g;

const nodeSpawnLike: SpawnLike = (program, args, options) => nodeSpawn(program, args, options);
const pad2 = (n: number): string => String(n).padStart(2, '0');
const eventClock = (d: Date): string =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const scrubMessage = (error: unknown): string =>
  scrubSecrets(error instanceof Error ? error.message : String(error)).replace(TOKEN_RUN, '[REDACTED]');
/** A single-token executor name for the LEADER row: whitespace cannot corrupt it. */
const executorToken = (provider: string): string => provider.replace(/[^A-Za-z0-9_.:-]+/g, '-') || 'unknown';

const signalExitCode = (signal: NodeJS.Signals | null): number =>
  signal !== null && typeof osConstants.signals[signal] === 'number' ? 128 + osConstants.signals[signal] : 1;

/**
 * Plan a pass: the newest health reading is filed under `lastProvider` (the
 * login that ran it), and the first candidate in list order not proven
 * usage-limited wins. No spawning — the pure plan a caller can dry-run.
 */
export async function planPlannerPass(
  opts: PlanOpts,
): Promise<{ health: PlannerHealth; choice: PlannerRunnerChoice }> {
  const now = opts.now ?? Date.now();
  const health = await readPlannerHealth(opts.runsRoot, now);
  const choice = selectPlannerRunner(opts.candidates, { [opts.lastProvider]: health }, now);
  return { health, choice };
}

/**
 * Run one planner pass. ORCH_OFF short-circuits before any health read; an
 * all-limited slate short-circuits before any spawn. The run log is opened
 * before the child so even a spawn-failed attempt leaves its reason on disk.
 */
export async function runPlannerPass(opts: RunPlannerPassOpts): Promise<PlannerRunResult> {
  const runsRoot = opts.runsRoot ?? join(homedir(), '.ashlr-runs');
  const clock = (): number => opts.now ?? Date.now();
  const done = (
    outcome: PlannerRunResult['outcome'],
    fields: { provider?: string | null; exitCode?: number | null; logPath?: string | null; nextResetAt?: string | null } = {},
  ): PlannerRunResult => ({
    v: 1,
    provider: fields.provider ?? null,
    outcome,
    exitCode: fields.exitCode ?? null,
    logPath: fields.logPath ?? null,
    startedAt: new Date(clock()).toISOString(),
    finishedAt: new Date(clock()).toISOString(),
    nextResetAt: fields.nextResetAt ?? null,
  });

  let provider: string | null = null;
  try {
    const switches = await readRunsSwitches({ runsDir: runsRoot });
    if (switches.switches.some((row) => row.id === 'ORCH_OFF' && row.on)) return done('skipped-orch-off');
    const { choice } = await planPlannerPass(opts);
    if (!choice.ok) return done('no-runner', { nextResetAt: choice.nextResetAt });
    provider = choice.provider;

    let logPath: string | null = null;
    let log: WriteStream;
    try {
      await mkdir(join(runsRoot, 'supervisor'), { recursive: true, mode: 0o700 });
      await mkdir(join(runsRoot, 'queue'), { recursive: true, mode: 0o700 });
      logPath = join(runsRoot, 'supervisor', `run.${new Date(clock()).toISOString().replace(/:/g, '-')}.log`);
      log = createWriteStream(logPath, { mode: 0o600 });
      await once(log, 'open');
      // A late stream error must never crash the pass; finished() still sees it.
      log.on('error', () => undefined);
    } catch {
      return done('spawn-failed', { provider, logPath });
    }

    const fail = (error: unknown): PlannerRunResult => {
      log.write(`[phantom] planner spawn-failed: ${scrubMessage(error)}\n`);
      return done('spawn-failed', { provider, logPath });
    };
    try {
      const program = choice.argv[0];
      if (!program) return fail(new Error('planner candidate argv is empty'));
      let prompt: string;
      try {
        const stat = await lstat(opts.promptPath);
        if (!stat.isFile() || stat.size > MAX_PROMPT_BYTES) throw new Error('planner prompt missing or over 8 MiB');
        prompt = await readFile(opts.promptPath, 'utf8');
      } catch (error) {
        return fail(error);
      }
      let child: SpawnedPlannerProcess;
      try {
        child = (opts.spawn ?? nodeSpawnLike)(program, choice.argv.slice(1), {
          env: { ...process.env, ...(opts.env ?? {}) },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        return fail(error);
      }
      if (child.stdin === null) return fail(new Error('planner child has no stdin pipe'));

      type Terminal = { kind: 'error'; message: string }
        | { kind: 'close'; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean };
      const timeoutMs = Math.max(1, Number.isFinite(opts.timeoutMs) ? opts.timeoutMs! : DEFAULT_TIMEOUT_MS);
      const terminal = await new Promise<Terminal>((resolve) => {
        let settled = false;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, timeoutMs);
        const settle = (value: Terminal): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        child.stdout?.pipe(log, { end: false });
        child.stderr?.pipe(log, { end: false });
        child.stdin?.on('error', () => { /* child closed stdin early; close decides */ });
        // `on`, not `once`: a second error event must never crash the pass.
        child.on('error', (error) => settle({ kind: 'error', message: scrubMessage(error) }));
        child.once('close', (code, signal) => settle({ kind: 'close', code, signal, timedOut }));
        child.stdin?.end(prompt, 'utf8');
      });

      if (terminal.kind === 'error') return fail(new Error(terminal.message));
      const exitCode = terminal.timedOut ? 124 : terminal.code ?? signalExitCode(terminal.signal);
      const row = `${eventClock(new Date(clock()))} LEADER ${executorToken(provider)} ${exitCode === 0 ? 'ok' : `rc=${exitCode}`}\n`;
      try {
        await appendFile(join(runsRoot, 'queue', 'dispatch-events.log'), row, { encoding: 'utf8', flag: 'a', mode: 0o600 });
      } catch (error) {
        log.write(`[phantom] LEADER row append failed: ${scrubMessage(error)}\n`);
      }
      return done('ran', { provider, exitCode, logPath });
    } catch (error) {
      return fail(error);
    } finally {
      log.end();
      await finished(log).catch(() => undefined);
    }
  } catch {
    return done('spawn-failed', { provider });
  }
}
