import { spawn } from 'node:child_process';
import { runLocalGate } from './local-gate.js';
import { readRunsSwitches, type RunsSwitchesV1 } from './runs-switches.js';

interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface GatedWorkerDeps {
  cwd?: string;
  readControls?: () => Promise<RunsSwitchesV1>;
  gate?: (budget: number, cwd: string) => Promise<{ verdict: 'pass' | 'fail' }>;
  signals?: SignalSource;
  escalationMs?: number;
}

export interface GatedWorkerResult {
  code: number;
  verdict: 'pass' | 'gate-failed' | 'worker-failed' | 'controls-blocked' | 'interrupted';
}

const blocking = new Set(['ORCH_OFF', 'PAUSE', 'HOLD', 'QUEUE_DISABLE']);
const signalCode = (signal: NodeJS.Signals): number => signal === 'SIGINT' ? 130 : 143;

/** Launch exactly one worker and wait for its close before checking the same worktree. */
export async function runGatedWorker(argv: string[], budget: number, deps: GatedWorkerDeps = {}): Promise<GatedWorkerResult> {
  const cwd = deps.cwd ?? process.cwd();
  const signals = deps.signals ?? process;
  let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const interrupt = (signal: 'SIGINT' | 'SIGTERM') => {
    if (interrupted) return;
    interrupted = signal;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      escalation = setTimeout(() => { child?.kill('SIGKILL'); }, deps.escalationMs ?? 2000);
      escalation.unref();
    }
  };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  signals.on('SIGINT', onInt);
  signals.on('SIGTERM', onTerm);
  const interruptedResult = (): GatedWorkerResult => ({ code: signalCode(interrupted!), verdict: 'interrupted' });
  try {
    let controls: RunsSwitchesV1;
    try { controls = await (deps.readControls ?? readRunsSwitches)(); }
    catch { return interrupted ? interruptedResult() : { code: 1, verdict: 'controls-blocked' }; }
    if (interrupted) return interruptedResult();
    if (controls.sourceState === 'degraded' || controls.switches.some(row => row.on && blocking.has(row.id))) {
      return { code: 1, verdict: 'controls-blocked' };
    }
    const worker = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      try {
        child = spawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: 'inherit' });
        child.on('error', () => { /* close supplies the final status */ });
        child.once('close', (code, signal) => resolve({ code, signal }));
      } catch { resolve({ code: null, signal: null }); }
    });
    if (escalation) clearTimeout(escalation);
    child = undefined;
    if (interrupted) return interruptedResult();
    if (worker.code !== 0) {
      const code = worker.code && worker.code > 0 ? worker.code :
        (worker.signal === 'SIGINT' || worker.signal === 'SIGTERM' ? signalCode(worker.signal) : 1);
      return { code, verdict: 'worker-failed' };
    }
    try {
      const gate = await (deps.gate ?? ((seconds, dir) => runLocalGate(seconds, { cwd: dir })))(budget, cwd);
      if (interrupted) return interruptedResult();
      return gate.verdict === 'pass' ? { code: 0, verdict: 'pass' } : { code: 1, verdict: 'gate-failed' };
    } catch {
      return interrupted ? interruptedResult() : { code: 1, verdict: 'gate-failed' };
    }
  } finally {
    if (escalation) clearTimeout(escalation);
    signals.off('SIGINT', onInt);
    signals.off('SIGTERM', onTerm);
  }
}
