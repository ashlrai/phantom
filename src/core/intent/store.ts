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
  if (ledger.schema !== INTENT_LEDGER_SCHEMA) throw new IntentError(`Intent ledger must be ${INTENT_LEDGER_SCHEMA}.`);
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
