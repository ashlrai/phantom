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
  const workerExit = await runContextWorker(opts, io);
  if (workerExit !== 0) {
    stderr.write(resultLine(workerExit, 'skipped'));
    return workerExit;
  }
  let gateVerdict: ContextCheckedRunGateVerdict;
  try {
    gateVerdict = (await runLocalGate(opts.budgetSeconds, io.gate)).verdict;
  } catch {
    gateVerdict = 'error';
  }
  stderr.write(resultLine(workerExit, gateVerdict));
  return gateVerdict === 'pass' ? 0 : 1;
}
