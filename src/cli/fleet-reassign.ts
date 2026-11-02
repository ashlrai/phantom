/** `ashlr fleet reassign` — RQ-PHX-RUNSREASSIGNVERB01: move queued jobs
 * between dispatcher lanes by rewriting their queue/ready.tsv rows in place.
 * A dry run is the default: without --apply the verb prints the plan (what
 * would move, what would be skipped and why) and touches neither ready.tsv
 * nor queue/reassign.log. With --apply the write goes through
 * rewriteReadyRows' write-verify-retry loop against the dispatcher's
 * whole-file rewrite; the report then reflects the verified final state.
 *
 *   ashlr fleet reassign RQ-PHX-FAKEONE01 --lane devin --apply
 *   ashlr fleet reassign --from codex-personal --lane devin --apply --reason "lane held"
 */
import { isAbsolute } from 'node:path';
import { rejectUnknownOptions } from './args.js';
import { makeColors, isTty } from './ui.js';
import { reassignQueuedJobs, ReassignError, type ReassignInput, type ReassignReportV1 } from '../core/fleet/runs-reassign.js';

const { red } = makeColors(isTty());
const USAGE = 'usage: ashlr fleet reassign <RQ-PHX-ID> --lane <lane> [--tier <tier>] [--apply] [--force] [--reason <text>] [--json] [--runs-dir <abs>]\n' +
  '       ashlr fleet reassign --from <lane> --lane <lane> [--tier <tier>] [--apply] [--force] [--reason <text>] [--json] [--runs-dir <abs>]';
const VALUE_FLAGS = new Set(['--lane', '--tier', '--reason', '--runs-dir', '--from']);
const BOOL_FLAGS = new Set(['--apply', '--force', '--json']);

interface ReassignDeps {
  reassign?: typeof reassignQueuedJobs;
}

const fail = (message: string): number => {
  process.stderr.write(red('error: ') + `fleet reassign: ${message}\n${USAGE}\n`);
  return 2;
};

/** One line per move and per skip — the shared body of human output. */
export function formatReassignReport(report: ReassignReportV1): string {
  const lines: string[] = [];
  for (const move of report.moved) {
    lines.push(`${report.applied ? 'moved' : 'move'} ${move.id}  ${move.fromLane}/${move.fromTier} -> ${move.toLane}/${move.toTier}`);
  }
  for (const skip of report.skipped) lines.push(`skip ${skip.id}  ${skip.reason}`);
  if (report.moved.length === 0 && report.skipped.length === 0) lines.push('nothing queued matches');
  if (!report.applied) {
    lines.push(`dry run: add --apply to move ${report.moved.length} job(s)`);
  } else if (report.verified === false) {
    const attempted = report.moved.length + report.skipped.filter((skip) => skip.reason === 'unverified').length;
    lines.push(`NOT verified: the dispatcher rewrote ready.tsv under us; ${report.moved.length} of ${attempted} move(s) confirmed — re-run to retry`);
  } else if (report.verified === true) {
    lines.push(`verified: ready.tsv holds the ${report.moved.length} reassigned row(s)`);
  }
  return lines.join('\n');
}

export async function cmdFleetReassign(args: string[], deps: ReassignDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  const bad = rejectUnknownOptions(args, { flags: [...BOOL_FLAGS], values: [...VALUE_FLAGS] });
  if (bad) return fail(bad.message);

  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (VALUE_FLAGS.has(token)) { values.set(token, args[++i]!); continue; }
    if (BOOL_FLAGS.has(token)) { flags.add(token); continue; }
    if (!token.startsWith('-')) positionals.push(token);
  }

  const fromLane = values.get('--from');
  const lane = values.get('--lane');
  const runsDir = values.get('--runs-dir');
  if (!lane) return fail('--lane is required');
  if (fromLane !== undefined && positionals.length > 0) return fail('a job id and --from are mutually exclusive');
  if (fromLane === undefined && positionals.length !== 1) return fail('exactly one job id (or --from <lane>) is required');
  if (runsDir !== undefined && !isAbsolute(runsDir)) return fail('--runs-dir requires an absolute path');

  const input: ReassignInput = {
    lane,
    apply: flags.has('--apply'),
    ...(flags.has('--force') ? { force: true } : {}),
    ...(fromLane !== undefined ? { fromLane } : { job: positionals[0]! }),
    ...(values.get('--tier') !== undefined ? { tier: values.get('--tier') } : {}),
    ...(values.get('--reason') !== undefined ? { reason: values.get('--reason') } : {}),
  };
  const reassign = deps.reassign ?? reassignQueuedJobs;
  let report: ReassignReportV1;
  try {
    report = await reassign(input, { ...(runsDir !== undefined ? { runsDir } : {}), changedBy: 'ashlr fleet reassign' });
  } catch (error) {
    process.stderr.write(red('error: ') + (error instanceof ReassignError
      ? `fleet reassign: ${error.code}: ${error.message}\n`
      : `fleet reassign: ${(error as Error).message}\n`));
    return 1;
  }

  console.log(flags.has('--json') ? JSON.stringify(report) : formatReassignReport(report));
  return report.applied && report.verified === false ? 1 : 0;
}
