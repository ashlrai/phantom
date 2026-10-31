import { readHarnessDigest } from '../core/learn/harness-digest-reader.js';

const HELP = `Usage: phm reflect harness-digest --file <markdown> --json [--stale-days <n>]
Read a local digest (maximum 1 MiB) and emit dated HTTPS citations as JSON.
Dates are UTC calendar days; older than N days is stale (default 7, boundary is fresh).
Missing, invalid, or future dates have null checkedAt and stale, with an issue.
Malformed IDs are issues; duplicate IDs remain in sources with an issue.
Issue codes: malformed_id, duplicate_id, missing_checked, invalid_checked,
future_checked, missing_urls. Only links on Source lines are included.
Options: --file <markdown>  Input file; --json  Required JSON output;
         --stale-days <n>  Non-negative integer; --help, -h  Show help.`;

export function cmdReflectHarnessDigest(args: string[], now = new Date()): number {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  let file: string | undefined;
  let json = false;
  let staleDays: number | undefined;
  const usage = (): number => {
    process.stderr.write('error: invalid harness-digest arguments; run `phm reflect harness-digest --help` for usage.\n');
    return 2;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--file' && file === undefined) {
      const value = args[++i];
      if (!value || value.startsWith('-')) return usage();
      file = value;
    } else if (arg === '--stale-days' && staleDays === undefined) {
      const value = args[++i];
      if (!value || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) return usage();
      staleDays = Number(value);
    } else return usage();
  }
  if (!file || !json) return usage();
  const result = readHarnessDigest(file, now, staleDays);
  if (!result) {
    process.stderr.write('error: unable to read digest as a stable regular file (maximum 1 MiB).\n');
    return 1;
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  return 0;
}
