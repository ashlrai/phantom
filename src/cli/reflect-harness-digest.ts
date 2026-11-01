import { readHarnessDigest, type HarnessDigest } from '../core/learn/harness-digest-reader.js';
import { sanitizeCommandLine } from '../core/verse/shell-integration.js';
import { makeColors, type Colors } from './ui.js';

const HELP = `Usage: phm reflect harness-digest --file <markdown> (--json | --text) [--source <id>]... [--query <text>] [--stale-days <n>] [--needs-refresh] [--with-takeaways] [--check]
Read a local digest (maximum 1 MiB) and emit dated HTTPS citations as JSON.
Dates are UTC calendar days; older than N days is stale (default 7, boundary is fresh).
Missing, invalid, or future dates have null checkedAt and stale, with an issue.
Malformed IDs are issues; duplicate IDs remain in sources with an issue.
Issue codes: malformed_id, duplicate_id, missing_checked, invalid_checked,
future_checked, missing_urls. Only links on Source lines are included.
Repeat --source to select records and issues matching any exact ID (S followed by digits).
For multiple distinct IDs, requestedSourceIds lists the requested IDs in request order.
With --needs-refresh, include only stale or undated selected sources and sources whose
IDs are referenced by selected issues; v and selected issues are preserved.
With --with-takeaways, select only sources with at least one nonblank takeaway;
this composes with --needs-refresh and preserves v and selected issues.
With --query, select sources whose title or retained takeaway contains the nonblank
text as a case-insensitive literal substring. Whitespace is significant. Issues are
scoped to matching source IDs, including all issues for a matching duplicate ID.
This searches the local digest only; no semantic or code index or network is used.
With --check, exit 0 for a non-empty selection with all sources fresh and no issues;
exit 1 for an empty selection, an ID absent from the digest, stale or undated sources,
issues, or read failure. Requested IDs are checked before takeaway filtering.
The check evaluates the selection before --needs-refresh, after --source,
--with-takeaways and --query. Without --query, issues remain scoped by --source
and are not filtered by takeaways.
With --text, print one line per selected takeaway — source ID, checked date (or
undated), text — capped at 200 lines with a trailing count of any elided
takeaways. Displayed fields are stripped of terminal control characters, and
the date is colored by freshness only when stdout is a TTY.
Invalid arguments exit 2. Without --check, a successfully read digest exits 0.
Options: --file <markdown>  Input file; --json | --text  Required output mode;
         --source <id>  Exact source ID (repeatable); --stale-days <n>  Non-negative integer;
         --query <text>  Literal title or takeaway substring (case-insensitive);
         --needs-refresh  Filter sources;
         --with-takeaways  Filter sources to those with takeaways;
         --check  Check freshness;
         --help, -h  Show help.`;

/** Maximum lines printed by --text; the last line reports any elided takeaways. */
const TEXT_LINE_CAP = 200;

/** Untrusted value for one terminal line: no control or bidi characters, no newlines. */
const displayField = (value: string): string => sanitizeCommandLine(value).replace(/\n+/g, ' ');

/** Terminal-readable rendering of the selected digest: one line per takeaway. Never fetches or executes content. */
function formatHarnessDigestText(digest: HarnessDigest, color: Colors): string {
  const lines: string[] = [];
  for (const source of digest.sources) {
    const date = source.checkedAt ?? 'undated';
    const dateField = source.stale === true ? color.red(date) : source.stale === null ? color.yellow(date) : color.dim(date);
    const stamp = `${color.dim(displayField(source.id))} ${dateField}`;
    for (const takeaway of source.takeaways ?? []) {
      const text = displayField(takeaway);
      if (text) lines.push(`${stamp} ${text}`);
    }
  }
  if (lines.length === 0) return '(no takeaways)\n';
  if (lines.length > TEXT_LINE_CAP) {
    // Keep the total at the cap: the last line reports how many takeaways were elided.
    return [...lines.slice(0, TEXT_LINE_CAP - 1), `(+${lines.length - TEXT_LINE_CAP + 1} more takeaways)`].join('\n') + '\n';
  }
  return lines.join('\n') + '\n';
}

export function cmdReflectHarnessDigest(args: string[], now = new Date()): number {
  if (args.some((arg, i) => (arg === '--help' || arg === '-h') && (i === 0 || args[i - 1] !== '--query'))) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  let file: string | undefined;
  let json = false;
  let text = false;
  let check = false;
  let needsRefresh = false;
  let withTakeaways = false;
  let query: string | undefined;
  const sourceIds = new Set<string>();
  let staleDays: number | undefined;
  const usage = (): number => {
    process.stderr.write('error: invalid harness-digest arguments; run `phm reflect harness-digest --help` for usage.\n');
    return 2;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--text' && !text) text = true;
    else if (arg === '--check' && !check) check = true;
    else if (arg === '--needs-refresh' && !needsRefresh) needsRefresh = true;
    else if (arg === '--with-takeaways' && !withTakeaways) withTakeaways = true;
    else if (arg === '--file' && file === undefined) {
      const value = args[++i];
      if (!value || value.startsWith('-')) return usage();
      file = value;
    } else if (arg === '--source') {
      const value = args[++i];
      if (!value || !/^S\d+$/.test(value)) return usage();
      sourceIds.add(value);
    } else if (arg === '--query' && query === undefined) {
      const value = args[++i];
      if (value === undefined || !value.trim()) return usage();
      query = value.toLowerCase();
    } else if (arg === '--stale-days' && staleDays === undefined) {
      const value = args[++i];
      if (!value || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) return usage();
      staleDays = Number(value);
    } else return usage();
  }
  if (!file || json === text) return usage();
  const result = readHarnessDigest(file, now, staleDays);
  if (!result) {
    process.stderr.write('error: unable to read digest as a stable regular file (maximum 1 MiB).\n');
    return 1;
  }
  const presentIds = new Set(result.sources.map(source => source.id));
  const missingSource = [...sourceIds].some(id => !presentIds.has(id));
  const sourceSelection = sourceIds.size === 0 ? result : {
    ...result,
    sources: result.sources.filter(source => sourceIds.has(source.id)),
    issues: result.issues.filter(issue => sourceIds.has(issue.id)),
    ...(sourceIds.size > 1 ? { requestedSourceIds: [...sourceIds] } : {}),
  };
  const takeawaySelection = withTakeaways ? {
    ...sourceSelection,
    sources: sourceSelection.sources.filter(source => source.takeaways?.some(takeaway => takeaway.trim().length > 0)),
  } : sourceSelection;
  let selected = takeawaySelection;
  if (query !== undefined) {
    const sources = selected.sources.filter(source =>
      source.title.toLowerCase().includes(query) || source.takeaways?.some(takeaway => takeaway.toLowerCase().includes(query)),
    );
    const ids = new Set(sources.map(source => source.id));
    selected = { ...selected, sources, issues: selected.issues.filter(issue => ids.has(issue.id)) };
  }
  const issueIds = new Set(selected.issues.map(issue => issue.id));
  const output = needsRefresh
    ? { ...selected, sources: selected.sources.filter(source => source.stale !== false || issueIds.has(source.id)) }
    : selected;
  process.stdout.write(json
    ? JSON.stringify(output) + '\n'
    : formatHarnessDigestText(output, makeColors(process.stdout.isTTY === true)));
  return check && (missingSource || selected.sources.length === 0 || selected.issues.length > 0 || selected.sources.some(source => source.stale !== false)) ? 1 : 0;
}
