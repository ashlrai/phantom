/**
 * Local store for ashlr.intent-ledger/v1.
 * ~/.ashlr-runs/intent/ledger.json (or ASHLR_RUNS_DIR), mode 0600.
 * The repository never holds the ledger.
 */
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertMetadata } from '../connectors/profile.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { INTENT_LEDGER_SCHEMA, IntentError, emptyLedger, isIntentLedger, type IntentLedger } from './schema.js';

const MAX_BYTES = 2 * 1024 * 1024;

export function intentRunsDir(root?: string): string {
  return root ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
}

export function intentLedgerPath(root?: string): string {
  return join(intentRunsDir(root), 'intent', 'ledger.json');
}

function textOf(ledger: IntentLedger): string {
  return ledger.items.map((item) => [
    item.title, item.source, item.owner, item.rq.join(' '),
    item.evidence.map((row) => `${row.ref} ${row.note ?? ''}`).join(' '),
    item.provenance.map((row) => row.source).join(' '),
  ].join('\n')).join('\n');
}

export function assertLedgerText(ledger: IntentLedger): void {
  try { assertMetadata(textOf(ledger)); }
  catch { throw new IntentError('Secret-shaped intent text was refused. Store vault names, not values.'); }
}

async function directory(root?: string): Promise<string> {
  const dir = join(intentRunsDir(root), 'intent');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new IntentError('Intent directory must be a regular directory.');
  await chmod(dir, 0o700);
  return dir;
}

export async function ledgerFilePresent(root?: string): Promise<boolean> {
  try {
    const info = await lstat(intentLedgerPath(root));
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function readLedger(root?: string): Promise<IntentLedger> {
  const path = intentLedgerPath(root);
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger();
    throw new IntentError('Intent ledger could not be read.');
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BYTES) {
    throw new IntentError('Intent ledger must be a regular file under 2 MiB.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch { throw new IntentError('Intent ledger is not valid JSON.'); }
  if (!isIntentLedger(parsed)) throw new IntentError(`Intent ledger must be ${INTENT_LEDGER_SCHEMA}.`);
  return parsed;
}

export async function writeLedger(ledger: IntentLedger, root?: string): Promise<void> {
  if (!isIntentLedger(ledger)) throw new IntentError(`Intent ledger must be ${INTENT_LEDGER_SCHEMA}.`);
  assertLedgerText(ledger);
  const dir = await directory(root);
  const target = join(dir, 'ledger.json');
  const tmp = join(dir, `.ledger.${randomBytes(4).toString('hex')}.tmp`);
  const body = `${JSON.stringify(ledger)}\n`;
  if (Buffer.byteLength(body) > MAX_BYTES) throw new IntentError('Intent ledger is too large.');
  await writeFile(tmp, body, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
  await chmod(target, 0o600);
}

const LOCK_FILE = 'ledger.lock';
/** Bounded wait for a concurrent writer; contention fails, never hangs. */
const LOCK_WAIT_MS = 2_000;

/**
 * In-process serialization per ledger path. The file lock below coordinates
 * across processes; this queue keeps same-process callers from contending with
 * themselves (a second caller would otherwise burn the whole wait budget
 * failing 'contended' while the first still holds the lock).
 */
const ledgerQueues = new Map<string, Promise<void>>();

async function transactIntentLedgerLocked<T>(
  root: string | undefined,
  mutate: (ledger: IntentLedger) => T | Promise<T>,
): Promise<T> {
  const dir = await directory(root);
  const outcome = acquireLocalStoreLockWithOutcome(join(dir, LOCK_FILE), LOCK_WAIT_MS, { anchorPath: dir });
  if (outcome.state !== 'acquired') {
    throw new IntentError(outcome.state === 'contended'
      ? 'Intent ledger is busy; another writer holds the lock. Retry the write.'
      : 'Intent ledger lock is unavailable.');
  }
  try {
    const ledger = await readLedger(root);
    const result = await mutate(ledger);
    await writeLedger(ledger, root);
    return result;
  } finally {
    releaseLocalStoreLock(outcome.lock);
  }
}

/**
 * Run one read-modify-write of the intent ledger as a bounded transaction:
 * the per-ledger file lock is held across readLedger, `mutate` and
 * writeLedger, so concurrent agents cannot silently drop each other's writes.
 * `mutate` receives the freshest ledger and must not re-enter this function
 * for the same ledger. Any throw — validation, capacity, secret-text refusal —
 * skips the write and leaves the persisted ledger untouched; the lock is
 * always released.
 *
 * Scope: this covers addIntent/updateIntent/importIntentFiles only. Other
 * ledger writers (release.ts, merge-snapshot.ts, fleet-intent CLI paths) still
 * do unlocked read-modify-write and are documented legacy writers.
 */
export async function transactIntentLedger<T>(
  root: string | undefined,
  mutate: (ledger: IntentLedger) => T | Promise<T>,
): Promise<T> {
  const key = intentLedgerPath(root);
  const previous = ledgerQueues.get(key) ?? Promise.resolve();
  const run = previous.then(() => transactIntentLedgerLocked(root, mutate));
  const settled = run.then(() => undefined, () => undefined);
  ledgerQueues.set(key, settled);
  try {
    return await run;
  } finally {
    if (ledgerQueues.get(key) === settled) ledgerQueues.delete(key);
  }
}
