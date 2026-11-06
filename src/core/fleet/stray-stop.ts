import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { defaultStrayReaders, readStraySlots, STRAY_ID_PATTERN, VERSE_FLEET_CONTROL_STRAY_SLOTS_PATH, type StraySlotsReport } from './stray-slots.js';

export const VERSE_FLEET_CONTROL_STRAY_STOP_PATH = VERSE_FLEET_CONTROL_STRAY_SLOTS_PATH;
export interface StrayStopAction { action: 'stop'; lane: string; job: string; pid: number }
export interface StrayStopResultV1 {
  v: 1; lane: string; job: string; pid: number;
  result: 'signalled' | 'already-gone'; report: StraySlotsReport;
}
export class StrayStopError extends Error {
  constructor(readonly status: 409, readonly code: 'not-a-stray' | 'not-permitted') {
    super(code === 'not-a-stray' ? 'Process is no longer a stray.' : 'Stopping this process is not permitted.');
    this.name = 'StrayStopError';
  }
}
export function parseStrayStopAction(body: unknown): StrayStopAction | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const row = body as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || Object.keys(row).some(key => !['action', 'lane', 'job', 'pid'].includes(key)) ||
      row.action !== 'stop' || typeof row.lane !== 'string' || !STRAY_ID_PATTERN.test(row.lane) ||
      typeof row.job !== 'string' || !STRAY_ID_PATTERN.test(row.job) || typeof row.pid !== 'number' || !Number.isSafeInteger(row.pid) || row.pid <= 1) return null;
  return { action: 'stop', lane: row.lane, job: row.job, pid: row.pid };
}
export interface StrayStopDeps {
  readStraySlots: () => Promise<StraySlotsReport>;
  kill: (pid: number, signal: 'SIGTERM') => unknown;
  ledgerFile: string;
  now: () => Date;
}
export async function stopStray(action: StrayStopAction, deps: StrayStopDeps = {
  readStraySlots: () => readStraySlots(defaultStrayReaders),
  kill: (pid, signal) => process.kill(pid, signal),
  ledgerFile: join(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'stray-stops.jsonl'),
  now: () => new Date(),
}): Promise<StrayStopResultV1> {
  const fresh = await deps.readStraySlots();
  if (!parseStrayStopAction(action) || action.pid === process.pid || !fresh.lanes.some(lane => lane.lane === action.lane &&
      lane.strays.some(stray => stray.job === action.job && stray.pid === action.pid))) throw new StrayStopError(409, 'not-a-stray');
  // Validate the audit sink before signalling; never follow links or block on a FIFO.
  const log = await open(deps.ledgerFile, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let result: StrayStopResultV1['result'] = 'signalled';
  try {
    const stat = await log.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Invalid stray stop ledger');
    try { deps.kill(action.pid, 'SIGTERM'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') result = 'already-gone';
      else if (code === 'EPERM') throw new StrayStopError(409, 'not-permitted');
      else throw error;
    }
    await log.writeFile(`${scrubSecrets(JSON.stringify({ at: deps.now().toISOString(), lane: action.lane, job: action.job, pid: action.pid, result }))}\n`);
  } finally { await log.close(); }
  return { v: 1, lane: action.lane, job: action.job, pid: action.pid, result, report: await deps.readStraySlots() };
}
