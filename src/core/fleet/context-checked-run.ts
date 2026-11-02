import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { runContextWorker, type ContextWorkerIO, type ContextWorkerOptions } from './context-worker-run.js';
import { runLocalGate, type LocalGateDeps } from './local-gate.js';

export interface ContextCheckedRunOptions extends ContextWorkerOptions {
  /** Forwarded to the local gate; undefined keeps its production default. */
  budgetSeconds?: number;
}
export interface ContextCheckedRunIO extends ContextWorkerIO {
  /** LocalGateDeps seams for tests; production leaves this undefined. */
  gate?: LocalGateDeps;
}
export type ContextCheckedRunGateVerdict = 'pass' | 'fail' | 'skipped' | 'error';

/** One fixed-shape stderr line; key order is part of the contract. */
function resultLine(workerExit: number, gateVerdict: ContextCheckedRunGateVerdict): string {
  return `context-checked-run: ${JSON.stringify({ workerExit, gateVerdict })}\n`;
}

/**
 * Runs the cited-context worker, then requires the real local gate on the
 * working tree before reporting success. The gate runs exactly once, only
 * after worker exit 0; a nonzero worker result skips it entirely. A gate
 * failure or throw is a nonzero result — nothing claims verification before
 * the gate promise settles. This is local working-tree verification, not
 * merge or publish authority, and the two steps are not an atomic
 * transaction.
 */
export async function runContextCheckedRun(opts: ContextCheckedRunOptions, io: ContextCheckedRunIO = {}): Promise<number> {
  const stderr = io.stderr ?? process.stderr;
  let cwd: string;
  try {
    const selected = opts.cwd === undefined ? process.cwd() : opts.cwd;
    if (typeof selected !== 'string' || !selected || selected.includes('\0') || !isAbsolute(selected)) throw new Error();
    cwd = realpathSync(selected);
    if (!statSync(cwd).isDirectory()) throw new Error();
  } catch {
    stderr.write('context-checked-run: invalid working directory\n');
    stderr.write(resultLine(2, 'skipped'));
    return 2;
  }
  if (io.gate?.cwd !== undefined) {
    let gateCwd: string;
    try {
      if (typeof io.gate.cwd !== 'string' || !isAbsolute(io.gate.cwd)) throw new Error();
      gateCwd = realpathSync(io.gate.cwd);
    } catch {
      stderr.write('context-checked-run: gate working directory conflicts with worker\n');
      stderr.write(resultLine(2, 'skipped'));
      return 2;
    }
    if (gateCwd !== cwd) {
      stderr.write('context-checked-run: gate working directory conflicts with worker\n');
      stderr.write(resultLine(2, 'skipped'));
      return 2;
    }
  }
  const workerExit = await runContextWorker({ ...opts, cwd }, io);
  if (workerExit !== 0) {
    stderr.write(resultLine(workerExit, 'skipped'));
    return workerExit;
  }
  let gateVerdict: ContextCheckedRunGateVerdict;
  try {
    gateVerdict = (await runLocalGate(opts.budgetSeconds, { ...io.gate, cwd })).verdict;
  } catch {
    gateVerdict = 'error';
  }
  stderr.write(resultLine(workerExit, gateVerdict));
  return gateVerdict === 'pass' ? 0 : 1;
}
