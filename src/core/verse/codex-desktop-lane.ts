/**
 * Worktree task adapter for the Codex Desktop app. This helper is not a
 * built-in fleet seat and does not infer the app's billing account.
 *
 * What this module never does:
 * - read, copy or reference ~/.codex*, the keychain, app databases or any credential;
 * - touch the MACCU TCC helper or grant access itself (the chat's operator grant,
 *   confirmation card, denylist and KILL all still apply inside `computer_*`);
 * - run two tasks against one app at once (one live conversation per app).
 *
 * Every probe (load, memory, git, gh) is injected, so the gates are testable
 * without a desktop, a GUI session or a real repository.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { cpus as osCpus, homedir, loadavg as osLoadavg } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { readHostLoad, type HostLoad } from '../fleet/host-load.js';
import { MAX_TASK_CHARS, runDesktopSmoke, type DesktopAdapter, type DesktopSmokeOptions, type DesktopSmokeReport } from './desktop-adapters.js';

/** Admission limits. Load uses the existing ratio tone (`ok` below 1.5x cores). */
export interface DesktopLaneLimits {
  /** Refuse to submit when the 1-minute load per core is at or above this. */
  maxLoadRatio: number;
  /** Refuse to submit when the system-wide free memory percentage is below this. */
  minMemoryFreePercent: number;
}

export const DEFAULT_DESKTOP_LANE_LIMITS: DesktopLaneLimits = { maxLoadRatio: 1.5, minMemoryFreePercent: 15 };

export interface DesktopHostSample {
  load: HostLoad;
  /** `memory_pressure -Q` free percentage, or null when unreadable. */
  memoryFreePercent: number | null;
}

export type DesktopLaneAdmission = { admit: true } | { admit: false; reason: string };

/** Fail closed: an unknown load or memory reading refuses the submission. */
export function evaluateDesktopLaneAdmission(sample: DesktopHostSample, limits: DesktopLaneLimits = DEFAULT_DESKTOP_LANE_LIMITS): DesktopLaneAdmission {
  const { ratio, load1, cores } = sample.load;
  if (ratio === null || load1 === null || cores === null) return { admit: false, reason: 'host load unknown' };
  if (ratio >= limits.maxLoadRatio) return { admit: false, reason: `host load ${load1} on ${cores} cores is at or above ${limits.maxLoadRatio}x` };
  if (sample.memoryFreePercent === null) return { admit: false, reason: 'memory free percentage unknown' };
  if (sample.memoryFreePercent < limits.minMemoryFreePercent) {
    return { admit: false, reason: `memory free ${sample.memoryFreePercent}% is below ${limits.minMemoryFreePercent}%` };
  }
  return { admit: true };
}

/** Parse `memory_pressure -Q` output: `System-wide memory free percentage: 55%`. */
export function parseMemoryFreePercent(text: string | null): number | null {
  const value = Number(text?.match(/System-wide memory free percentage:\s*(\d{1,3})%/i)?.[1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

export interface HostProbes {
  loadavg: () => number[];
  cpus: () => unknown[];
  /** Host platform; defaults to the real one inside readHostLoad when absent. */
  platform?: () => string;
  /** Runs a read-only system command; resolves null on failure or timeout. */
  command: (file: string, args: string[]) => Promise<string | null>;
}

export const DEFAULT_HOST_PROBES: HostProbes = {
  loadavg: osLoadavg,
  cpus: osCpus,
  command: (file, args) => new Promise((resolveCommand) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 256 * 1024 }, (error, stdout) => resolveCommand(error ? null : String(stdout)));
  }),
};

/** Measure the host right before a submission. Never throws. */
export async function measureDesktopHost(probes: HostProbes = DEFAULT_HOST_PROBES): Promise<DesktopHostSample> {
  const load = readHostLoad({ loadavg: probes.loadavg, cpus: probes.cpus, platform: probes.platform });
  const pressure = await probes.command('/usr/bin/memory_pressure', ['-Q']).catch(() => null);
  return { load, memoryFreePercent: parseMemoryFreePercent(pressure) };
}

/** Refuse any worktree that could reach a Codex credential store or Phantom's own state. */
export function checkLaneWorktree(path: string, home: string = homedir()): { ok: true; path: string } | { ok: false; error: string } {
  if (!isAbsolute(path)) return { ok: false, error: 'worktree must be an absolute path' };
  const normalized = resolve(path);
  if (/[\0\n\r]/.test(normalized)) return { ok: false, error: 'worktree path has control characters' };
  const forbidden = [join(home, '.codex'), join(home, '.ashlr'), join(home, '.ashlr-runs')];
  const segments = normalized.split(sep);
  if (segments.some((segment) => /^\.codex/i.test(segment))) return { ok: false, error: 'worktree is inside a Codex credential directory' };
  for (const root of forbidden) {
    if (normalized === root || normalized.startsWith(root + sep)) return { ok: false, error: 'worktree is inside Phantom or Codex state' };
  }
  try {
    if (!statSync(normalized).isDirectory()) return { ok: false, error: 'worktree is not a directory' };
  } catch {
    return { ok: false, error: 'worktree does not exist' };
  }
  return { ok: true, path: normalized };
}

export interface GitProbes {
  /** Current branch name, or null when detached or unreadable. */
  branch(worktree: string): Promise<string | null>;
  /** Number of uncommitted entries in `git status --porcelain`, or null when unreadable. */
  dirtyCount(worktree: string): Promise<number | null>;
  /** URL of an open PR whose head is `branch`, or null. */
  prUrl(worktree: string, branch: string): Promise<string | null>;
}

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

export const DEFAULT_GIT_PROBES: GitProbes = {
  branch: async (worktree) => {
    const out = await runCommand('/usr/bin/git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const name = out?.trim() ?? '';
    return name && name !== 'HEAD' && BRANCH_RE.test(name) ? name : null;
  },
  dirtyCount: async (worktree) => {
    const out = await runCommand('/usr/bin/git', ['-C', worktree, 'status', '--porcelain']);
    return out === null ? null : out.split('\n').filter((line) => line.trim() !== '').length;
  },
  prUrl: async (worktree, branch) => {
    const out = await runCommand('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""'], worktree);
    const url = out?.trim() ?? '';
    return /^https:\/\/github\.com\/[^\s]+\/pull\/\d+$/.test(url) ? url : null;
  },
};

function runCommand(file: string, args: string[], cwd?: string): Promise<string | null> {
  return new Promise((resolveCommand) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 256 * 1024, cwd }, (error, stdout) => resolveCommand(error ? null : String(stdout)));
  });
}

/** The prompt the Codex app receives: the worktree boundary first, then the queued task. */
export function buildLanePrompt(worktree: string, task: string): string {
  return [
    `Work only inside this git worktree: ${worktree}`,
    'Do not read or change anything outside it, and do not touch credential or app-state directories.',
    'When finished, name the branch you worked on and the PR URL if you opened one.',
    '',
    task.trim(),
  ].join('\n');
}

export interface CodexLaneJob {
  id: string;
  task: string;
  worktree: string;
}

export type CodexLaneResult =
  | { ok: true; jobId: string; branch: string; dirtyFiles: number; prUrl: string | null; text: string; polls: number }
  | { ok: false; stage: 'job' | 'admission' | 'busy' | 'worktree' | 'start' | 'status' | 'collect' | 'git'; error: string };

/** Bundle ids with a task in flight in this process: one live conversation per app. */
const inFlight = new Set<string>();

export interface CodexLaneDeps {
  adapter: DesktopAdapter;
  bundle: string;
  host?: () => Promise<DesktopHostSample>;
  git?: GitProbes;
  limits?: DesktopLaneLimits;
  home?: string;
  smoke?: Pick<DesktopSmokeOptions, 'timeoutMs' | 'pollMs' | 'sleep' | 'now'>;
}

/** Submit one queued task to the Codex Desktop app and collect its branch and PR. */
export async function runCodexDesktopLaneTask(job: CodexLaneJob, deps: CodexLaneDeps): Promise<CodexLaneResult> {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(job.id)) return { ok: false, stage: 'job', error: 'job id must be 1-80 letters, digits, dot, dash or underscore' };
  if (!job.task.trim()) return { ok: false, stage: 'job', error: 'task is empty' };
  const worktree = checkLaneWorktree(job.worktree, deps.home);
  if (!worktree.ok) return { ok: false, stage: 'worktree', error: worktree.error };
  const prompt = buildLanePrompt(worktree.path, job.task);
  if (prompt.length > MAX_TASK_CHARS) return { ok: false, stage: 'job', error: `task plus worktree boundary exceeds ${MAX_TASK_CHARS} characters` };

  const admission = evaluateDesktopLaneAdmission(await (deps.host ?? measureDesktopHost)(), deps.limits);
  if (!admission.admit) return { ok: false, stage: 'admission', error: admission.reason };

  if (inFlight.has(deps.bundle)) return { ok: false, stage: 'busy', error: 'a task is already running in this app' };
  inFlight.add(deps.bundle);
  try {
    const report: DesktopSmokeReport = await runDesktopSmoke(deps.adapter, prompt, deps.smoke);
    if (!report.ok) return { ok: false, stage: report.stage, error: report.error };
    const git = deps.git ?? DEFAULT_GIT_PROBES;
    const branch = await git.branch(worktree.path);
    if (!branch) return { ok: false, stage: 'git', error: 'the worktree has no branch checked out' };
    const dirtyFiles = await git.dirtyCount(worktree.path);
    if (dirtyFiles === null) return { ok: false, stage: 'git', error: 'git status could not be read' };
    const prUrl = await git.prUrl(worktree.path, branch);
    return { ok: true, jobId: job.id, branch, dirtyFiles, prUrl, text: report.text, polls: report.polls };
  } finally {
    inFlight.delete(deps.bundle);
  }
}
