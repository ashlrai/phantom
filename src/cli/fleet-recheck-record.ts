/** `ashlr fleet recheck-record` — append one sanitized recheck verdict row to
 * the local history, or read it back with --last. Grants no authority and
 * sends nothing; exit 0 means the write succeeded, whatever the verdict. */
import { homedir } from 'node:os';
import { ashlrHome } from '../core/cloud/store.js';
import { readFleetRecheck, type FleetRecheck, type FleetRecheckDeps } from '../core/fleet/fleet-recheck.js';
import { appendRecheckRecord, readRecheckRecords, type RecheckRecord } from '../core/fleet/recheck-record.js';

const usage = 'Usage: ashlr fleet recheck-record [--last N [--json]]\n'
  + 'Without flags: runs the read-only recheck and appends one sanitized row to the\n'
  + 'local recheck log (newest 500 kept); prints "recorded <overall> as-of=<asOf>".\n'
  + '--last N (1..50, default 5): prints the newest N rows, newest first; --json prints them as an array.\n'
  + 'Exit 0 when the write succeeded, 1 when it failed, 2 on bad arguments.';

export interface FleetRecheckRecordDeps {
  /** Ashlr home root; defaults to ashlrHome(). */
  root?: string;
  homeDir?: () => string;
  readRecheck?: () => FleetRecheck | Promise<FleetRecheck>;
  recheckDeps?: FleetRecheckDeps;
}

function row(r: RecheckRecord): string {
  const s = r.sections;
  return `${r.asOf} ${r.overall} runtime=${s.runtime.state} claims=${s.claims.state} bridge=${s.bridge.state} task=${s.task.state}`;
}

export async function cmdFleetRecheckRecord(args: string[], deps: FleetRecheckRecordDeps = {}): Promise<number> {
  let last: number | null = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--last' && last === null) {
      const raw = args[++i];
      const n = raw !== undefined && /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
      if (n >= 1 && n <= 50) { last = n; continue; }
    }
    console.error(usage);
    return 2;
  }
  if (json && last === null) { console.error(usage); return 2; }
  try {
    const root = deps.root ?? ashlrHome();
    if (last !== null) {
      const { rows, skipped, missing } = readRecheckRecords(root, last);
      if (json) { console.log(JSON.stringify(rows)); return 0; }
      if (missing) { console.log('no recheck records'); return 0; }
      for (const r of rows) console.log(row(r));
      if (skipped > 0) console.log(`skipped=${skipped}`);
      return 0;
    }
    const recheck = await (deps.readRecheck ?? (() => readFleetRecheck(deps.recheckDeps)))();
    const res = appendRecheckRecord(root, recheck, (deps.homeDir ?? homedir)());
    if (!res.ok) { console.error(`record failed: ${res.reason}`); return 1; }
    console.log(`recorded ${res.record.overall} as-of=${res.record.asOf}`);
    return 0;
  } catch {
    console.error('record failed: unexpected error');
    return 1;
  }
}
