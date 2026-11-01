/** Explicit, foreground planner execution; no queue discovery or post-launch retry. */
import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { readPlannerHealth, selectPlannerRunner, type PlannerHealth } from './planner-failover.js';
import { readRunsSwitches } from './runs-switches.js';

interface Candidate {
  provider: string; executable: string; argv: string[]; cwd: string; runsRoot: string; CODEX_HOME?: string;
}
interface PassConfig { timeoutMs: number; candidates: Candidate[] }
export interface PlannerPassResult {
  provider: string | null;
  status: 'completed' | 'failed' | 'spawn-error' | 'timed-out' | 'cancelled' | 'blocked' | 'no-runner';
  exitCode: number | null;
  reason?: string;
  nextResetAt?: string | null;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const absolute = (v: unknown): v is string => typeof v === 'string' && isAbsolute(v) && !v.includes('\0');
function outsideCodex(path: string): void {
  // Reject before filesystem access, including descendants and lexical aliases.
  const forbidden = join(homedir(), '.codex');
  if (resolve(path) === forbidden || resolve(path).startsWith(forbidden + sep)) throw new Error('personal .codex is forbidden');
}
async function safePath(path: string): Promise<void> {
  outsideCodex(path);
  // Resolve existing ancestors too, so symlinked parents cannot alias .codex.
  let ancestor = path;
  for (;;) {
    try { outsideCodex(await realpath(ancestor)); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = resolve(ancestor, '..');
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}
function parseConfig(raw: unknown): PassConfig {
  if (!object(raw) || !Number.isSafeInteger(raw.timeoutMs) || Number(raw.timeoutMs) < 1 || Number(raw.timeoutMs) > 3_600_000
    || !Array.isArray(raw.candidates) || raw.candidates.length < 1 || raw.candidates.length > 64) throw new Error('invalid planner config');
  const providers = new Set<string>();
  for (const c of raw.candidates) {
    if (!object(c) || typeof c.provider !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(c.provider)
      || providers.has(c.provider) || !absolute(c.executable) || !absolute(c.cwd) || !absolute(c.runsRoot)
      || !Array.isArray(c.argv) || !c.argv.every((a: unknown) => typeof a === 'string' && !a.includes('\0'))
      || (c.CODEX_HOME !== undefined && !absolute(c.CODEX_HOME))) throw new Error('invalid planner candidate');
    providers.add(c.provider);
  }
  return raw as unknown as PassConfig;
}
export async function executePlannerPass(configPath: string, promptPath: string, signal?: AbortSignal): Promise<PlannerPassResult> {
  if (!absolute(configPath) || !absolute(promptPath)) throw new Error('config and prompt-file must be absolute paths');
  await safePath(configPath); await safePath(promptPath);
  const config = parseConfig(JSON.parse(await readFile(configPath, 'utf8')));
  const promptStat = await stat(promptPath);
  if (!promptStat.isFile() || promptStat.size > 8 * 1024 * 1024) throw new Error('invalid prompt file (maximum 8 MiB)');
  const prompt = await readFile(promptPath);
  const health: Record<string, PlannerHealth> = Object.create(null) as Record<string, PlannerHealth>;
  const now = Date.now();
  for (const c of config.candidates) {
    for (const path of [c.executable, c.cwd, c.runsRoot, c.CODEX_HOME ?? c.runsRoot]) await safePath(path);
    health[c.provider] = await readPlannerHealth(c.runsRoot, now);
  }
  const choice = selectPlannerRunner(config.candidates, health, now);
  if (!choice.ok) return { provider: null, status: 'no-runner', exitCode: null, reason: choice.reason, nextResetAt: choice.nextResetAt };
  const c = config.candidates.find((c) => c.provider === choice.provider)!;
  const switches = await readRunsSwitches({ runsDir: c.runsRoot });
  if (switches.sourceState !== 'healthy' || switches.switches.some((s) => s.on && ['ORCH_OFF', 'PAUSE', 'HOLD', 'QUEUE_DISABLE', 'OPUS_LEADER_OFF'].includes(s.id))) {
    return { provider: c.provider, status: 'blocked', exitCode: null, reason: 'planner holds or switch state unavailable' };
  }
  if (signal?.aborted) return { provider: c.provider, status: 'cancelled', exitCode: null };
  // Override inherited CODEX_HOME; without explicit login use the configured runs root,
  // never the provider's implicit ~/.codex. No directory or auth file is created.
  return new Promise((done) => {
    const child = spawn(c.executable, [...choice.argv], {
      cwd: c.cwd, env: { ...process.env, CODEX_HOME: c.CODEX_HOME ?? c.runsRoot },
      shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    });
    let status: PlannerPassResult['status'] | undefined;
    const stop = (why: 'cancelled' | 'timed-out'): void => { status ??= why; child.kill('SIGKILL'); };
    const cancel = (): void => stop('cancelled');
    const timer = setTimeout(() => stop('timed-out'), config.timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.on('error', () => { status ??= 'spawn-error'; });
    child.stdin.on('error', () => { status ??= 'failed'; child.kill('SIGKILL'); });
    child.once('close', (exitCode) => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      done({ provider: c.provider, status: status ?? (exitCode === 0 ? 'completed' : 'failed'), exitCode: status === 'spawn-error' ? null : exitCode });
    });
    child.stdin.end(prompt);
  });
}
