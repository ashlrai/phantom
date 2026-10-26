/**
 * Measure a proposal's declared metric at one exact commit, in a private
 * detached worktree. The metric command is repository code (like CI) and runs
 * without credentials from this process's environment. Under a standing grant
 * it also runs inside the verification sandbox, as every other execution of
 * agent-written code does. Any failure yields an unknown measurement with a
 * reason; it never yields a number.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MetricSpec } from './outcomes.js';

export type MeasureExec = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => string;
const MEASURE_TIMEOUT_MS = 20 * 60 * 1000;
const realExec: MeasureExec = (cmd, args, cwd, env) => execFileSync(cmd, args, {
  cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: MEASURE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
});

/**
 * Only what a metric needs to run; tokens, API keys and agent session variables stay out.
 * HOME is replaced with a private empty directory: the measured head is agent-written code,
 * and the real HOME holds gh, npm, git and SSH credentials as files.
 */
const PASS_THROUGH = ['PATH', 'LANG', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];
export function metricEnv(source: NodeJS.ProcessEnv = process.env, home?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1' };
  for (const k of PASS_THROUGH) if (typeof source[k] === 'string') env[k] = source[k];
  if (home) {
    env.HOME = home;
    env.USERPROFILE = home;
    env.XDG_CONFIG_HOME = join(home, '.config');
    // The npm tarball cache is integrity-checked content, not credentials; reuse it so measuring stays fast.
    if (typeof source.HOME === 'string' && existsSync(join(source.HOME, '.npm'))) env.npm_config_cache = join(source.HOME, '.npm');
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}

const GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

export function parseMetricOutput(stdout: string, metric: string): number {
  const last = stdout.split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  if (!last) throw new Error('metric printed nothing');
  let parsed: unknown;
  try { parsed = JSON.parse(last); } catch { throw new Error('last stdout line is not JSON'); }
  const o = parsed as { metric?: unknown; value?: unknown };
  if (!o || typeof o !== 'object' || o.metric !== metric) throw new Error(`last stdout line does not name metric ${metric}`);
  if (typeof o.value !== 'number' || !Number.isFinite(o.value)) throw new Error('metric value is not a finite number');
  return o.value;
}

export interface Measurement { sha: string; value: number | null; reason: string | null }

/** The metric command run inside a sandbox opened on the measured worktree. Rejects on a non-zero exit. */
export interface MetricSandbox { run: (argv: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>; close: () => void }
/**
 * Opens the sandbox for one measured worktree. Resolves null when no standing
 * grant is live (legacy: the command runs as before). Throws when a grant is
 * live but no sandbox can be built; the measurement is then unknown and the
 * command never runs unconfined.
 */
export type MetricConfinement = (worktree: string) => Promise<MetricSandbox | null>;

export async function measureAt(
  repoDir: string,
  sha: string,
  metric: MetricSpec,
  exec: MeasureExec = realExec,
  confine?: MetricConfinement,
): Promise<Measurement> {
  if (!/^[0-9a-f]{40}$/.test(sha)) return { sha, value: null, reason: 'not an exact 40-hex commit' };
  const container = mkdtempSync(join(realpathSync(tmpdir()), 'phm-measure-'));
  const wt = join(container, 'checkout');
  let added = false;
  let sandbox: MetricSandbox | null = null;
  try {
    // Hooks off: with core.hooksPath pointing into the tree (husky), checkout would run the measured commit's hook with our credentials.
    exec('git', [...GIT, 'worktree', 'add', '--detach', wt, sha], repoDir);
    added = true;
    const head = exec('git', [...GIT, 'rev-parse', 'HEAD'], wt).trim();
    if (head !== sha) return { sha, value: null, reason: 'checkout did not land on the requested commit' };
    const home = join(container, 'home');
    mkdirSync(home, { mode: 0o700 });
    const env = metricEnv(process.env, home);
    if (metric.runner.kind === 'node' && !existsSync(join(wt, metric.runner.path))) {
      return { sha, value: null, reason: `metric script ${metric.runner.path} is missing at this commit` };
    }
    // Opened before the install: a live grant with no sandbox refuses before anything runs.
    sandbox = confine ? await confine(wt) : null;
    const run = (cmd: string, args: string[]): Promise<string> | string =>
      sandbox ? sandbox.run([cmd, ...args], wt, env) : exec(cmd, args, wt, env);
    let stdout: string;
    if (metric.runner.kind === 'npm') {
      // The install runs no package scripts (--ignore-scripts) and needs the registry, which the sandbox denies.
      if (existsSync(join(wt, 'package-lock.json'))) exec('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], wt, env);
      stdout = await run('npm', ['run', '--silent', metric.runner.script]);
    } else {
      stdout = await run(process.execPath, [metric.runner.path]);
    }
    return { sha, value: parseMetricOutput(stdout, metric.name), reason: null };
  } catch (err) {
    return { sha, value: null, reason: (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300) };
  } finally {
    try { sandbox?.close(); } catch { /* its private dir is removed with ~/.ashlr/tmp */ }
    try { if (added) exec('git', [...GIT, 'worktree', 'remove', '--force', wt], repoDir); } catch { /* pruned below */ }
    try { exec('git', [...GIT, 'worktree', 'prune'], repoDir); } catch { /* best effort */ }
    rmSync(container, { recursive: true, force: true }); // Private mkdtemp directory owned by this call.
  }
}

/**
 * The standing-grant sandbox verification uses (inbox/merge.ts
 * openStandingVerificationConfinement): writes only to the worktree and a
 * private run dir, no network egress, HOME jailed, Phantom's authority state
 * unreadable. The measured head is agent-written code; under a standing grant
 * nobody reviewed it before the gate runs it.
 */
export const standingMetricConfinement: MetricConfinement = async (worktree) => {
  const { openStandingVerificationConfinement } = await import('../inbox/merge.js');
  const confined = await openStandingVerificationConfinement(worktree);
  if (!confined) return null;
  return {
    close: confined.close,
    run: async (argv, cwd, env) => {
      const res = await confined.runSubprocess(argv, { cwd, env, timeoutMs: MEASURE_TIMEOUT_MS, maxOutputChars: 1024 * 1024 });
      if (res.error) throw new Error(res.error);
      if (res.timedOut) throw new Error('metric timed out');
      if (res.exitCode !== 0) throw new Error(`metric exited ${res.exitCode}: ${res.stderr.trim().split('\n')[0] ?? ''}`);
      return res.stdout;
    },
  };
};
