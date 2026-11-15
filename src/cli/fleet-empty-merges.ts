import {
  EMPTY_MERGE_DEFAULT_LIMIT,
  EMPTY_MERGE_DEFAULT_REF,
  EMPTY_MERGE_MAX_LIMIT,
  scanEmptyMerges,
} from '../core/fleet/empty-merge-scan.js';

const usage = `Usage: ashlr fleet empty-merges [--ref ${EMPTY_MERGE_DEFAULT_REF}] [--limit N] [--json]
List landed bridge merges whose real change is empty or evidence-only (limit 1–${EMPTY_MERGE_MAX_LIMIT}, default ${EMPTY_MERGE_DEFAULT_LIMIT}). Read-only.`;

const VALID_REF = /^[A-Za-z0-9._/-]{1,100}$/;

type Dependencies = { cwd?: string; exec?: (args: string[]) => string };

/**
 * Read-only report of `bridge(` merges on a ref whose files carry no real
 * change. Exit 0 only when no such merge is found; 1 when rows exist or the
 * git source is unavailable; 2 on bad usage. SHAs, job ids and counts only.
 */
export async function cmdFleetEmptyMerges(args: string[], deps: Dependencies = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return 0;
  }
  let json = false, ref = EMPTY_MERGE_DEFAULT_REF, limit = EMPTY_MERGE_DEFAULT_LIMIT;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !seen.has(arg)) {
      json = true;
    } else if ((arg === '--ref' || arg === '--limit') && !seen.has(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) { console.error(usage); return 2; }
      if (arg === '--ref') {
        if (!VALID_REF.test(value)) { console.error(usage); return 2; }
        ref = value;
      } else {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))
          || Number(value) < 1 || Number(value) > EMPTY_MERGE_MAX_LIMIT) { console.error(usage); return 2; }
        limit = Number(value);
      }
    } else {
      console.error(usage);
      return 2;
    }
    seen.add(arg);
  }
  const report = scanEmptyMerges({ cwd: deps.cwd, exec: deps.exec, ref, limit });
  if (json) {
    console.log(JSON.stringify(report));
  } else if (report.source === 'unavailable') {
    console.log(`empty-merges: git log unavailable for ${report.ref}`);
  } else {
    for (const row of report.rows) {
      console.log(`${row.sha.slice(0, 7)} ${row.job ?? '-'} ${row.verdict} files=${row.files}`);
    }
    console.log(`${report.rows.length} bridge merge${report.rows.length === 1 ? '' : 's'} with no real change (scanned ${report.scanned} on ${report.ref})`);
  }
  return report.source === 'unavailable' || report.rows.length > 0 ? 1 : 0;
}
