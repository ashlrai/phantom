/** `phm main blame` — find the first merge that turned the default branch red. Read-only. */
import { DEFAULT_CHECK_TIMEOUT_MS, MainBlameError, mainBlame, type MainBlameDeps, type MainBlameReport } from '../core/main-blame.js';

const USAGE = [
  'usage: phm main blame --good <sha> --check "<command>" [--bad <sha>] [--repo <path>] [--timeout-ms <n>] [--json]',
  'Bisects the merges after --good (last green) up to --bad (first red, default HEAD) in a temporary worktree,',
  'runs the check on each probe (exit 0 = green) and prints the first merge that fails it.',
  'Read-only: never pushes, reverts or resets.',
].join('\n');

export async function cmdMain(args: string[], deps: MainBlameDeps = {}): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === undefined || verb === '--help' || verb === '-h') { console.log(USAGE); return verb === undefined ? 2 : 0; }
  if (verb !== 'blame') { console.error(`error: unknown main command "${verb}"\n${USAGE}`); return 2; }
  const opts: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--help' || arg === '-h') { console.log(USAGE); return 0; }
    if (arg === '--json') { json = true; continue; }
    if (!['--repo', '--good', '--bad', '--check', '--timeout-ms'].includes(arg) || arg in opts) { console.error(`error: invalid argument ${arg}\n${USAGE}`); return 2; }
    const value = rest[++i];
    if (value === undefined || value === '') { console.error(`error: ${arg} needs a value\n${USAGE}`); return 2; }
    opts[arg] = value;
  }
  if (!opts['--good'] || !opts['--check']) { console.error(`error: --good and --check are required\n${USAGE}`); return 2; }
  const timeoutMs = opts['--timeout-ms'] === undefined ? DEFAULT_CHECK_TIMEOUT_MS : Number(opts['--timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) { console.error(`error: --timeout-ms must be a positive integer\n${USAGE}`); return 2; }
  let report: MainBlameReport;
  try {
    report = mainBlame({ repo: opts['--repo'] ?? process.cwd(), good: opts['--good'], bad: opts['--bad'] ?? 'HEAD', check: opts['--check'], timeoutMs }, deps);
  } catch (err) {
    console.error(err instanceof MainBlameError ? `error: ${err.message}` : `error: main blame failed: ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof MainBlameError ? 2 : 1;
  }
  if (json) console.log(JSON.stringify(report));
  else {
    const pr = report.pr_number === null ? '' : ` (#${report.pr_number})`;
    console.log(`First bad merge: ${report.first_bad_sha.slice(0, 10)}${pr} ${report.pr_title}`);
    console.log(`Authored by job: ${report.author_job_id ?? 'unknown'}`);
    console.log(`Check runs: ${report.checks_run}`);
  }
  return 0;
}
