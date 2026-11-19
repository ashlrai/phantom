/** phm fleet spend-ledger: read-only view of a recorded coding-pool spend ledger. */
import { isAbsolute } from 'node:path';
import {
  readSpendLedger,
  SPEND_LEDGER_MAX_BYTES,
  SPEND_LEDGER_MAX_ROWS,
  type SpendDecision,
  type SpendLedgerRead,
} from '../core/providers/coding-cli/ledger.js';

export const FLEET_SPEND_LEDGER_SCHEMA = 'fleet.spend-ledger.v1';

const USAGE = `Usage: phm fleet spend-ledger --file <absolute-jsonl-path> [--json]
Read recorded coding-pool spend decisions from one explicit local JSONL file. Read-only:
it never appends, reweights, routes, calls the network or grants spending permission.
Shows verification, CI, merge, quota and cost as recorded; a null quota or cost stays unknown.
Cost is in the pool's own unit: it is not converted to dollars and no remaining percentage is inferred.
Account identifiers and malformed lines are never printed; invalid lines are only counted.
Ceilings: reads the first ${SPEND_LEDGER_MAX_BYTES} bytes and lists the first ${SPEND_LEDGER_MAX_ROWS} valid rows; truncation is reported.
Exit 0 with the ledger, 2 on bad usage or when the file is missing or unreadable (unavailable).
An empty readable file is valid: status "empty".`;

const sum = (values: Array<number | null>): { known: number; unknown: number; total: number | null } => {
  const known = values.filter((v): v is number => v !== null);
  return { known: known.length, unknown: values.length - known.length, total: known.length ? known.reduce((a, b) => a + b, 0) : null };
};

/** Public row: account identifiers are dropped. */
const publicRow = (r: SpendDecision) => ({
  ts: r.ts, ...(r.repo !== undefined ? { repo: r.repo, pr: r.pr } : {}), poolId: r.poolId, billing: r.billing,
  balanceKnown: r.balanceKnown, expiryKnown: r.expiryKnown, complexity: r.complexity, risk: r.risk,
  backend: r.backend, model: r.model, escalations: r.escalations, verification: r.verification, ci: r.ci,
  merged: r.merged, timeMs: r.timeMs, quota: r.quota, cost: r.cost,
});

export function buildSpendLedgerReport(file: string, read: SpendLedgerRead) {
  return {
    schema: FLEET_SPEND_LEDGER_SCHEMA,
    readOnly: true as const,
    status: read.fileBytes === 0 ? 'empty' as const : 'ok' as const,
    source: { path: file, asOf: new Date(read.mtimeMs).toISOString(), fileBytes: read.fileBytes, bytesRead: read.bytesRead },
    limits: { maxBytes: SPEND_LEDGER_MAX_BYTES, maxRows: SPEND_LEDGER_MAX_ROWS },
    truncated: { bytes: read.bytesTruncated, rows: read.rowsTruncated },
    counts: { valid: read.validRows, invalid: read.invalidRows, listed: read.rows.length },
    measured: {
      merged: read.rows.filter((r) => r.merged).length,
      verificationPassed: read.rows.filter((r) => r.verification === 'passed').length,
      ciPassed: read.rows.filter((r) => r.ci === 'passed').length,
      quota: sum(read.rows.map((r) => r.quota)),
      cost: sum(read.rows.map((r) => r.cost)),
    },
    rows: read.rows.map(publicRow),
  };
}

export async function cmdFleetSpendLedger(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  let file: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--file' && file === undefined && args[i + 1] !== undefined) file = args[++i];
    else if (a.startsWith('--file=') && file === undefined) file = a.slice('--file='.length);
    else { console.error(USAGE); return 2; }
  }
  if (!file || !isAbsolute(file)) { console.error(USAGE); return 2; }
  let read: SpendLedgerRead;
  try {
    read = readSpendLedger(file);
  } catch {
    const message = 'Spend ledger is unavailable: the file is missing or unreadable.';
    if (json) console.log(JSON.stringify({ schema: FLEET_SPEND_LEDGER_SCHEMA, readOnly: true, status: 'unavailable', source: { path: file }, error: message }));
    else console.error(message);
    return 2;
  }
  const report = buildSpendLedgerReport(file, read);
  if (json) { console.log(JSON.stringify(report)); return 0; }
  const show = (n: number | null) => (n === null ? 'unknown' : String(n));
  console.log(`Spend ledger ${file} (as of ${report.source.asOf}): ${report.status}`);
  console.log(`${report.counts.valid} valid, ${report.counts.invalid} invalid lines, ${report.counts.listed} listed.`);
  if (report.truncated.bytes) console.log(`Truncated: read ${report.source.bytesRead} of ${report.source.fileBytes} bytes.`);
  if (report.truncated.rows) console.log(`Truncated: listing the first ${SPEND_LEDGER_MAX_ROWS} valid rows.`);
  if (report.status === 'empty') console.log('The file is empty: no spend recorded.');
  for (const r of report.rows) {
    const id = r.repo !== undefined ? ` ${r.repo}#${r.pr}` : '';
    console.log(`${r.ts}${id} ${r.poolId} ${r.billing} verify=${r.verification} ci=${r.ci} merged=${r.merged} quota=${show(r.quota)} cost=${show(r.cost)} (pool unit)`);
  }
  return 0;
}
