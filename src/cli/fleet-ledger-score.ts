/** phm fleet ledger-score: read-only historical score per coding pool from a recorded spend ledger. */
import { isAbsolute } from 'node:path';
import { readSpendLedger, SPEND_LEDGER_MAX_BYTES, SPEND_LEDGER_MAX_ROWS, type SpendLedgerRead } from '../core/providers/coding-cli/ledger.js';
import { LEDGER_SCORE_NOTE, scoreHistoricalPools, type PoolLedgerScore } from '../core/providers/coding-cli/ledger-score.js';

export const FLEET_LEDGER_SCORE_SCHEMA = 'fleet.ledger-score.v1';

const USAGE = `Usage: phm fleet ledger-score --file <absolute-jsonl-path> [--json]
Historical score per coding pool from recorded spend decisions in one explicit local JSONL file.
Read-only: it never appends, reweights, routes, calls the network or grants spending permission.
score = mergeRate * ciPassRate / (1 + costPerMerged), six decimals; 0 for a pool with no merges.
Unknown CI is excluded from the CI rate. Unknown merged cost is excluded from the cost sum, not counted as zero.
Costs are in each pool's own unit: scores are not comparable across pools and are not converted to dollars.
Scores cover only the listed sample (the first ${SPEND_LEDGER_MAX_ROWS} valid rows of the first ${SPEND_LEDGER_MAX_BYTES} bytes), never the full ledger.
Account identifiers, raw lines and malformed lines are never printed; invalid lines are only counted.
Exit 0 with the report (status "empty" for an empty readable file), 2 on bad usage or when the file is missing or unreadable.`;

interface Usage { file: string; json: boolean }

/** Strict flag parse: one absolute --file, optional --json, nothing else. */
function parseArgs(args: string[]): Usage | null {
  let file: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json' && !json) json = true;
    else if (a === '--file' && file === undefined && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) file = args[++i];
    else if (a.startsWith('--file=') && file === undefined) file = a.slice('--file='.length);
    else return null;
  }
  if (file === undefined || file === '' || !isAbsolute(file)) return null;
  return { file, json };
}

export function buildLedgerScoreReport(file: string, read: SpendLedgerRead) {
  const pools: PoolLedgerScore[] = scoreHistoricalPools(read.rows);
  return {
    schema: FLEET_LEDGER_SCORE_SCHEMA,
    readOnly: true as const,
    status: read.fileBytes === 0 ? 'empty' as const : 'ok' as const,
    note: LEDGER_SCORE_NOTE,
    comparableAcrossPools: false as const,
    coverage: 'listed-sample' as const,
    source: { path: file, asOf: new Date(read.mtimeMs).toISOString(), fileBytes: read.fileBytes, bytesRead: read.bytesRead },
    limits: { maxBytes: SPEND_LEDGER_MAX_BYTES, maxRows: SPEND_LEDGER_MAX_ROWS },
    truncated: { bytes: read.bytesTruncated, rows: read.rowsTruncated },
    counts: { valid: read.validRows, invalid: read.invalidRows, listed: read.rows.length },
    pools,
  };
}

export async function cmdFleetLedgerScore(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  const usage = parseArgs(args);
  if (!usage) { console.error(USAGE); return 2; }
  const { file, json } = usage;
  let read: SpendLedgerRead;
  try {
    read = readSpendLedger(file);
  } catch {
    const message = 'Ledger score is unavailable: the file is missing or unreadable.';
    if (json) console.log(JSON.stringify({ schema: FLEET_LEDGER_SCORE_SCHEMA, readOnly: true, status: 'unavailable', source: { path: file }, error: message }));
    else console.error(message);
    return 2;
  }
  const report = buildLedgerScoreReport(file, read);
  if (json) { console.log(JSON.stringify(report)); return 0; }
  console.log(`Ledger score ${file} (as of ${report.source.asOf}): ${report.status}`);
  console.log(`${report.counts.valid} valid, ${report.counts.invalid} invalid lines, ${report.counts.listed} listed (scores cover the listed sample only).`);
  if (report.truncated.bytes) console.log(`Truncated: read ${report.source.bytesRead} of ${report.source.fileBytes} bytes.`);
  if (report.truncated.rows) console.log(`Truncated: scoring the first ${SPEND_LEDGER_MAX_ROWS} valid rows.`);
  if (report.status === 'empty') console.log('The file is empty: no spend recorded.');
  console.log(LEDGER_SCORE_NOTE);
  for (const p of report.pools) {
    console.log(`${p.poolId} score=${p.score} merged=${p.merged}/${p.rows} mergeRate=${p.mergeRate.toFixed(4)} `
      + `ci=${p.ci.passed}/${p.ci.known} known (${p.ci.unknown} unknown) ciPassRate=${p.ciPassRate.toFixed(4)} `
      + `costPerMerged=${p.costPerMerged} (${p.cost.knownMerged} known, ${p.cost.unknownMerged} unknown merged cost; pool unit)`);
  }
  return 0;
}
