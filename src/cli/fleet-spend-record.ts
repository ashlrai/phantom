/** phm fleet spend-record: append one measured coding-pool spend row to an explicit local ledger. */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseSpendDecision, type SpendDecision } from '../core/providers/coding-cli/ledger.js';
import {
  appendSpendDecision,
  canonicalSpendLine,
  checkSpendLedgerTarget,
  SPEND_ROW_MAX_BYTES,
  SpendLedgerAppendError,
} from '../core/providers/coding-cli/ledger-append.js';

export const FLEET_SPEND_RECORD_SCHEMA = 'fleet.spend-record.v1';

const USAGE = `Usage: phm fleet spend-record --file <absolute-existing-jsonl-path> --row-file <absolute-json-file-path> [--apply] [--json]
Append one recorded coding-pool spend decision (a single JSON object) to an existing local JSONL ledger.
Preview is the default and writes nothing. --apply appends exactly the normalized row as one line.
Refused without writing: relative paths, missing or non-regular or symlink targets, unterminated ledgers,
ledgers at the read ceiling, row files over ${SPEND_ROW_MAX_BYTES} bytes, and any row the source parser rejects.
Nothing is created, no parent directory is made and no home directory is scanned. Null quota and cost stay null.
Recording is a measured assertion only: not provider verification, live balance evidence, dispatch authorization,
or a VERIFIED work claim. No network call, no reweighting, no routing change.
Receipt output never includes account identifiers, row contents or raw errors. Exit 0 on preview or applied, 2 on refusal or bad usage.`;

const NOTE = 'Recorded assertion only: not provider verification, balance evidence, dispatch authorization or a VERIFIED claim.';

/** Read a bounded, explicit, non-symlink regular row file; the caller validates its contents. */
function readRowFile(file: string): string {
  if (!isAbsolute(file)) throw new SpendLedgerAppendError('row file path must be absolute');
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
  } catch {
    throw new SpendLedgerAppendError('row file is missing, unreadable, or a symlink');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SpendLedgerAppendError('row file is not a regular file');
    if (st.size > SPEND_ROW_MAX_BYTES) throw new SpendLedgerAppendError('row file exceeds the row ceiling');
    // Read one byte past the ceiling so a file that grows during the read is still refused.
    const buf = Buffer.alloc(SPEND_ROW_MAX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
    }
    if (n > SPEND_ROW_MAX_BYTES) throw new SpendLedgerAppendError('row file exceeds the row ceiling');
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Parse the row file as one JSON object through the source parser; null means refused. */
export function decodeSpendRow(text: string): SpendDecision {
  const row = parseSpendDecision(text.trim());
  if (!row) throw new SpendLedgerAppendError('row file does not hold a valid spend decision');
  return row;
}

export function buildSpendRecordReceipt(status: 'preview' | 'applied', bytes: number) {
  return {
    schema: FLEET_SPEND_RECORD_SCHEMA,
    status,
    appended: status === 'applied',
    bytes,
    note: NOTE,
  };
}

export async function cmdFleetSpendRecord(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  let file: string | undefined;
  let rowFile: string | undefined;
  let apply = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--apply') apply = true;
    else if (a === '--file' && file === undefined && args[i + 1] !== undefined) file = args[++i];
    else if (a.startsWith('--file=') && file === undefined) file = a.slice('--file='.length);
    else if (a === '--row-file' && rowFile === undefined && args[i + 1] !== undefined) rowFile = args[++i];
    else if (a.startsWith('--row-file=') && rowFile === undefined) rowFile = a.slice('--row-file='.length);
    else { console.error(USAGE); return 2; }
  }
  if (!file || !rowFile || !isAbsolute(file) || !isAbsolute(rowFile)) { console.error(USAGE); return 2; }
  try {
    const row = decodeSpendRow(readRowFile(rowFile));
    const lineBytes = Buffer.byteLength(canonicalSpendLine(row), 'utf8');
    let bytes = lineBytes;
    if (apply) bytes = appendSpendDecision(file, row).bytes;
    else checkSpendLedgerTarget(file, lineBytes);
    const receipt = buildSpendRecordReceipt(apply ? 'applied' : 'preview', bytes);
    if (json) console.log(JSON.stringify(receipt));
    else console.log(`Spend record ${receipt.status}: ${bytes} bytes${apply ? ' appended' : ' (nothing written; pass --apply to append)'}. ${NOTE}`);
    return 0;
  } catch (error) {
    const message = error instanceof SpendLedgerAppendError ? error.message : 'Spend record refused: the target could not be written.';
    if (json) console.log(JSON.stringify({ schema: FLEET_SPEND_RECORD_SCHEMA, status: 'refused', appended: false, error: message }));
    else console.error(message);
    return 2;
  }
}
