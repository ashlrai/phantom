import { readHarnessDigest } from '../core/learn/harness-digest-reader.js';

const HELP = `Usage: phm reflect harness-digest --file <markdown> --json [--source <id>] [--stale-days <n>] [--needs-refresh] [--check]
Read a local digest (maximum 1 MiB) and emit dated HTTPS citations as JSON.
Dates are UTC calendar days; older than N days is stale (default 7, boundary is fresh).
Missing, invalid, or future dates have null checkedAt and stale, with an issue.
Malformed IDs are issues; duplicate IDs remain in sources with an issue.
Issue codes: malformed_id, duplicate_id, missing_checked, invalid_checked,
future_checked, missing_urls. Only links on Source lines are included.
With --source, select all records and issues matching an exact ID (S followed by digits).
With --needs-refresh, include only stale or undated selected sources and sources whose
IDs are referenced by selected issues; v and selected issues are preserved.
With --check, exit 0 for a non-empty selection with all sources fresh and no issues;
exit 1 for an empty selection, stale or undated sources, issues, or read failure.
Without --source, the check always evaluates the full digest, even with --needs-refresh.
With --source, the check evaluates the selection before --needs-refresh.
Invalid arguments exit 2. Without --check, a successfully read digest exits 0.
Options: --file <markdown>  Input file; --json  Required JSON output;
         --source <id>  Exact source ID; --stale-days <n>  Non-negative integer;
         --needs-refresh  Filter sources;
         --check  Check freshness;
         --help, -h  Show help.`;

export function cmdReflectHarnessDigest(args: string[], now = new Date()): number {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  let file: string | undefined;
  let json = false;
  let check = false;
  let needsRefresh = false;
  let sourceId: string | undefined;
  let staleDays: number | undefined;
  const usage = (): number => {
    process.stderr.write('error: invalid harness-digest arguments; run `phm reflect harness-digest --help` for usage.\n');
    return 2;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--check' && !check) check = true;
    else if (arg === '--needs-refresh' && !needsRefresh) needsRefresh = true;
    else if (arg === '--file' && file === undefined) {
      const value = args[++i];
      if (!value || value.startsWith('-')) return usage();
      file = value;
    } else if (arg === '--source' && sourceId === undefined) {
      const value = args[++i];
      if (!value || !/^S\d+$/.test(value)) return usage();
      sourceId = value;
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
  const selected = sourceId === undefined ? result : {
    ...result,
    sources: result.sources.filter(source => source.id === sourceId),
    issues: result.issues.filter(issue => issue.id === sourceId),
  };
  const issueIds = new Set(selected.issues.map(issue => issue.id));
  const output = needsRefresh
    ? { ...selected, sources: selected.sources.filter(source => source.stale !== false || issueIds.has(source.id)) }
    : selected;
  process.stdout.write(JSON.stringify(output) + '\n');
  return check && (selected.sources.length === 0 || selected.issues.length > 0 || selected.sources.some(source => source.stale !== false)) ? 1 : 0;
}
