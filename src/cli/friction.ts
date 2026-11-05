/**
 * cli/friction.ts — `phm friction`: the dispatch→merge friction ledger.
 * Read-only miners over ~/.ashlr-runs (ASHLR_RUNS_DIR overrides the root);
 * the only writes land in friction/ledger.jsonl — scan rows when counts
 * change and `note` rows from `phm friction note`. No secret values.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  appendFrictionLedger, foldFrictionLedger, frictionNoteRow, frictionScanRow,
  mineFriction, readFrictionInput,
} from '../core/fleet/friction.js';

const USAGE = `phm friction [--runs-dir <dir>] [--no-record] [--json]
phm friction note <item-id> --status open|in-progress|fixed|wontfix [--owner <owner>] [--runs-dir <dir>] [--json]
Mines ~/.ashlr-runs for recurring dispatch->merge friction (7d counts, evidence,
score = delegation unlocked x frequency x blast radius / cost). Appends a scan
row to friction/ledger.jsonl when counts change; before/after metrics and
status come from that ledger.`;

const parseArgs = (args: string[]): { dir: string; rest: string[] } | null => {
  const i = args.indexOf('--runs-dir');
  if (i === -1) return { dir: process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), rest: args.filter(a => a !== '--json') };
  const dir = args[i + 1];
  if (!dir || dir.startsWith('--')) return null;
  return { dir, rest: args.filter((a, j) => a !== '--json' && j !== i && j !== i + 1) };
};

export async function cmdFriction(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const emit = (v: unknown) => console.log(JSON.stringify(v, null, json ? 2 : undefined));
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) { console.log(USAGE); return 0; }
  const parsed = parseArgs(args);
  if (!parsed) { console.error(USAGE); return 2; }
  const { dir, rest } = parsed;
  if (rest[0] === 'note') {
    const id = rest[1], si = rest.indexOf('--status'), oi = rest.indexOf('--owner');
    const status = si >= 0 ? rest[si + 1] : undefined;
    const owner = oi >= 0 ? rest[oi + 1] : undefined;
    const row = id && status && !(owner ?? '').startsWith('--')
      ? frictionNoteRow(id, status, owner, Date.now()) : null;
    if (!row) { console.error('error: expected note <item-id> --status open|in-progress|fixed|wontfix [--owner <owner>]'); return 2; }
    try {
      await appendFrictionLedger(dir, [row]);
      if (json) emit({ ok: true, appended: JSON.parse(row) }); else console.log(`noted ${id}`);
      return 0;
    } catch { console.error('error: could not append to the friction ledger'); return 1; }
  }
  if (rest.some(a => a !== '--no-record')) { console.error(USAGE); return 2; }
  const input = await readFrictionInput(dir);
  const report = mineFriction(input);
  const row = frictionScanRow(report, foldFrictionLedger(input.ledger ?? ''), Date.now());
  if (row && !rest.includes('--no-record')) {
    // The ledger caches the report's own numbers; a failed append never fails the read.
    try { await appendFrictionLedger(dir, [row]); } catch { /* ledger append is best-effort */ }
  }
  if (json) emit(report);
  else for (const item of report.items) {
    const unit = item.metric.unit;
    console.log(`${item.id}\t${item.status}\tscore=${item.score ?? 'unknown'}\t${unit}=${item.signals[unit] ?? 'unknown'}`);
  }
  return 0;
}
