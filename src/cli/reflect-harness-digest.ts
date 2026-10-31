import { readHarnessDigest } from '../core/learn/harness-digest-reader.js';

const HELP = `Usage: phm reflect harness-digest --file <markdown> --json [--source <id>] [--stale-days <n>] [--needs-refresh] [--with-takeaways] [--query <text>] [--check]
Read a local digest (maximum 1 MiB) and emit dated HTTPS citations as JSON.
Dates are UTC calendar days; older than N days is stale (default 7, boundary is fresh).
Missing, invalid, or future dates have null checkedAt and stale, with an issue.
Malformed IDs are issues; duplicate IDs remain in sources with an issue.
Issue codes: malformed_id, duplicate_id, missing_checked, invalid_checked,
future_checked, missing_urls. Only links on Source lines are included.
With --source, select all records and issues matching an exact ID (S followed by digits).
With --needs-refresh, include only stale or undated selected sources and sources whose
IDs are referenced by selected issues; v and selected issues are preserved.
With --with-takeaways, include only selected sources with nonempty takeaway arrays;
this composes with --needs-refresh and preserves v and selected issues.
With --query, include sources whose title or retained explicit takeaway contains the
trimmed text as a case-insensitive literal substring. Query length: 1-256 characters.
This composes with the other display filters and preserves v and selected issues.
With --check, exit 0 for a non-empty selection with all sources fresh and no issues;
exit 1 for an empty selection, stale or undated sources, issues, or read failure.
Without --source, the check always evaluates the full digest, even with display filters.
With --source, the check evaluates the selection before --needs-refresh and --with-takeaways.
The --query display filter also does not affect --check.
Invalid arguments exit 2. Without --check, a successfully read digest exits 0.
Options: --file <markdown>  Input file; --json  Required JSON output;
         --source <id>  Exact source ID; --stale-days <n>  Non-negative integer;
         --needs-refresh  Filter sources;
         --with-takeaways  Filter sources to those with takeaways;
         --query <text>  Filter sources by title or retained takeaway;
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
  let withTakeaways = false;
  let sourceId: string | undefined;
  let query: string | undefined;
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
    else if (arg === '--with-takeaways' && !withTakeaways) withTakeaways = true;
    else if (arg === '--file' && file === undefined) {
      const value = args[++i];
      if (!value || value.startsWith('-')) return usage();
      file = value;
    } else if (arg === '--source' && sourceId === undefined) {
      const value = args[++i];
      if (!value || !/^S\d+$/.test(value)) return usage();
      sourceId = value;
    } else if (arg === '--query' && query === undefined) {
      const value = args[++i]?.trim();
      if (!value || Array.from(value).length > 256) return usage();
      query = value.toLowerCase();
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
  const output = needsRefresh || withTakeaways || query !== undefined
    ? { ...selected, sources: selected.sources.filter(source =>
      (!needsRefresh || source.stale !== false || issueIds.has(source.id)) &&
      (!withTakeaways || (source.takeaways?.length ?? 0) > 0) &&
      (query === undefined || source.title.toLowerCase().includes(query) ||
        source.takeaways?.some(takeaway => takeaway.toLowerCase().includes(query)))) }
    : selected;
  process.stdout.write(JSON.stringify(output) + '\n');
  return check && (selected.sources.length === 0 || selected.issues.length > 0 || selected.sources.some(source => source.stale !== false)) ? 1 : 0;
}
