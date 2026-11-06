/**
 * `ashlr fleet main-health [--json] [--strict]` — read-only view of the
 * main-guardian status table. Exit 0 by default; --strict exits 1 when any
 * repo is red, the status is stale or unavailable, or a fix PR is stuck, so agents can gate.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFleetMainHealth, type FleetMainHealthV1 } from '../core/fleet/main-health.js';
import { findStuckFixes, type StuckFixRow } from './fleet-stuck-fixes.js';

export interface FleetMainHealthOptions {
  runsDir?: string;
  now?: () => number;
  /** Test seam: read the jobs ledger at `path`. */
  readLedger?: (path: string) => Promise<string>;
}

const STUCK_THRESHOLD_MINUTES = 20;
interface StuckFixes { known: boolean; thresholdMinutes: number; stuck: StuckFixRow[] }

/** Fold the jobs ledger; an unreadable ledger is `known: false`, never an error. */
async function readStuckFixes(opts: FleetMainHealthOptions, nowMs: number): Promise<StuckFixes> {
  const root = opts.runsDir ?? (process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'));
  try {
    const text = await (opts.readLedger ?? ((path) => readFile(path, 'utf8')))(join(root, 'metrics', 'jobs.jsonl'));
    const { stuck } = findStuckFixes(text, nowMs, STUCK_THRESHOLD_MINUTES);
    return { known: true, thresholdMinutes: STUCK_THRESHOLD_MINUTES, stuck };
  } catch (err) {
    // No ledger file means no fix PR was ever published: nothing is stuck.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { known: true, thresholdMinutes: STUCK_THRESHOLD_MINUTES, stuck: [] };
    return { known: false, thresholdMinutes: STUCK_THRESHOLD_MINUTES, stuck: [] };
  }
}

const stuckText = (row: StuckFixRow): string => `fix PR stuck ${row.ageMinutes} min ${row.prUrl}`;
const matchesRepo = (row: StuckFixRow, repo: string): boolean =>
  row.repo !== null && (row.repo === repo || row.repo.slice(row.repo.lastIndexOf('/') + 1) === repo);

function render(report: FleetMainHealthV1, fixes: StuckFixes): string[] {
  const matched = new Set<StuckFixRow>();
  const rows = [...report.repos].sort((a, b) => Number(b.state === 'red') - Number(a.state === 'red'));
  const lines = rows.map((row) => {
    const fix = row.fixJobs.length ? `, fix ${row.fixJobs.join(' ')}` : '';
    const failing = row.state === 'red' && row.failingCheck ? ` (${row.failingCheck})` : '';
    const nightly = row.nightlyRed ? `, nightly red ${row.nightlyRed}` : '';
    const stuck = fixes.stuck.filter((s) => matchesRepo(s, row.repo));
    for (const s of stuck) matched.add(s);
    const stuckPart = stuck.map((s) => `, ${stuckText(s)}`).join('');
    return `${row.repo}/${row.branch}: ${row.state}${failing}${fix}${nightly}${stuckPart}`;
  });
  if (report.source === 'unavailable') lines.push('main-health: guardian status unavailable');
  else if (report.stale) lines.push(`main-health: guardian status stale (last ${report.statusAt ?? 'unknown'})`);
  if (report.guardianOff) lines.push('main-health: guardian is OFF (MAIN_GUARDIAN_OFF present)');
  for (const s of fixes.stuck) if (!matched.has(s)) lines.push(`main-health: ${stuckText(s)} (${s.job})`);
  if (!fixes.known) lines.push('main-health: fix PR ledger unread');
  return lines;
}

export async function cmdFleetMainHealth(args: string[], opts: FleetMainHealthOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('ashlr fleet main-health [--json] [--strict]\n' +
      'Read-only view of the main-guardian status: red default branches, failing check, open fix jobs.\n' +
      'Also shows fix PRs stuck open past 20 minutes (from metrics/jobs.jsonl); an unreadable ledger is reported, not fatal.\n' +
      'Exit 0 by default; --strict exits 1 when any repo is red, the status is stale or unavailable, or a fix PR is stuck.');
    return 0;
  }
  let json = false;
  let strict = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--strict') strict = true;
    else {
      console.error(`fleet main-health: unknown flag: ${arg}`);
      return 2;
    }
  }
  const report = await readFleetMainHealth(opts);
  const fixes = await readStuckFixes(opts, Date.parse(report.generatedAt));
  if (json) console.log(JSON.stringify({ ...report, stuckFixes: fixes }));
  else for (const line of render(report, fixes)) console.log(line);
  return strict && (report.red > 0 || report.stale || report.source === 'unavailable' || fixes.stuck.length > 0) ? 1 : 0;
}
