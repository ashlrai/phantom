/** `phm shipped`: thin handler. Parses argv and prints the report built in core/release/shipped.ts. */
import { hourShippedText, readHourShipped } from '../core/fleet/shipped-hour.js';
import { readFleetShipped } from '../core/fleet/shipped.js';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildShipped, gitShippedSource, recordsShippedSource, SHIPPED_DOC_PATH, shippedMarkdown, shippedText, type ShippedReport, type ShippedSource } from '../core/release/shipped.js';
import { SHIPPED_SITE_ITEMS, SHIPPED_SITE_JSON, SHIPPED_SITE_PAGE, shippedPage } from '../core/release/shipped-page.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm shipped [--since 7d] [--repo <name>] [--from <file>] [--json|--md|--site]
  phm shipped --since 1h [--json]   last hour from local git clones
  phm shipped --since 24h [--json]  fleet-wide merged PR feed (read-only GitHub + local metrics)
What shipped, in plain words: merged changes grouped by product area (desktop app, mobile, CLI,
fleet, channels, plugins, docs), opening with one top line. Tests, chores, fixups and reverts are
counted as maintenance and not listed; pull requests on the same feature fold into one line.
Day-based reports read local git history or --from; the 24h feed reads GitHub.
  --since <n>d   days to cover, 1d to 90d, default 7d
  --repo <name>  only this repository, as owner/name or just name
  --from <file>  read merged pull requests from a JSON list instead of git, for several repositories at once
                 (each: repo, number, title, merged_at, labels, files); - reads standard input
  --json         print the report as JSON (schema shipped.v1, version 1)
  --md           write ${SHIPPED_DOC_PATH} in this repository and print its path
  --site         write ${SHIPPED_SITE_JSON} and ${SHIPPED_SITE_PAGE} (the website page) and print their paths
Anything that could not be read prints as "unknown" (text) or null (JSON), never as zero.
Exit 0 ok, 1 when the source could not be read, 2 usage.`;

export interface ShippedDeps { now?: () => number; out?: (line: string) => void; err?: (line: string) => void; root?: string; source?: ShippedSource; fleet?: typeof readFleetShipped; hour?: typeof readHourShipped }

function repoRoot(): string {
  const run = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return run.status === 0 && run.stdout.trim() ? run.stdout.trim() : process.cwd();
}

export async function cmdShipped(args: string[], deps: ShippedDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  if (args.includes('1h')) {
    if (!['--since 1h', '--since 1h --json', '--json --since 1h'].includes(args.join(' '))) { err(usage); return 2; }
    const report = await (deps.hour ?? readHourShipped)({ now: (deps.now ?? Date.now)() });
    out(args.includes('--json') ? JSON.stringify(report) : hourShippedText(report).join('\n'));
    return report.complete ? 0 : 1;
  }
  if (args.includes('24h')) {
    const allArgs = args.join(" ");
    const valid24hArgs = ["--since 24h", "--since 24h --json", "--json --since 24h", "--since 24h --repo", "--since 24h --repo --json", "--json --since 24h --repo"];
    if (!valid24hArgs.includes(allArgs)) { err(usage); return 2; }
    const report = await (deps.fleet ?? readFleetShipped)({ now: (deps.now ?? Date.now)() });
    out(args.includes('--json') ? JSON.stringify(report) : [
      report.complete ? `${report.totals.merged} merged in the last 24 hours · ${report.totals.mergedPerHour} per hour · median open to merge: ${report.totals.medianOpenToMergeSeconds ?? 'unknown'} seconds` : 'Shipped is incomplete; totals are unknown.',
      ...report.items.map(pr => `${pr.repo} #${pr.number}: ${pr.title} · ${pr.jobId ?? 'unknown job'} · ${pr.lane ?? 'unknown lane'} · ${pr.openToMergeSeconds ?? 'unknown'} seconds · ${pr.url}`),
    ].join('\n'));
    return report.complete ? 0 : 1;
  }
  type Format = 'text' | 'json' | 'md' | 'site';
  let days = 7, format: Format = 'text', repo: string | null = null, from: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' || arg === '--md' || arg === '--site') {
      if (format !== 'text' && format !== arg.slice(2)) { err(`phm shipped: choose one of --json, --md or --site\n${usage}`); return 2; }
      format = arg.slice(2) as Format;
    } else if (arg === '--since') {
      const match = /^(\d{1,2})d$/.exec(args[++i] ?? '');
      days = match ? Number(match[1]) : NaN;
      if (!(days >= 1 && days <= 90)) { err(`phm shipped: --since takes a number of days such as 7d\n${usage}`); return 2; }
    } else if (arg === '--repo' || arg === '--from') {
      const value = args[++i] ?? '';
      if (!value || value.startsWith('--')) { err(`phm shipped: ${arg} needs a value\n${usage}`); return 2; }
      if (arg === '--repo') repo = value; else from = value;
    } else { err(`phm shipped: unknown option ${arg}\n${usage}`); return 2; }
  }
  const root = deps.root ?? repoRoot();
  const now = (deps.now ?? Date.now)();
  const fromFile: ShippedSource = () => {
    try { return recordsShippedSource(readFileSync(from === '-' ? 0 : from!, 'utf8')); }
    catch { return { state: 'unknown', note: 'The merged pull request file could not be read.', changes: [] }; }
  };
  const read = await (deps.source ?? (from === null ? gitShippedSource(root) : fromFile))(now - days * 86_400_000);
  // Scrubbed once here, so the JSON, the text and the pages can never differ in what they reveal.
  const report = sanitizePublicJson(buildShipped(read, { now, days, repo, maxLines: format === 'site' ? SHIPPED_SITE_ITEMS : undefined })) as ShippedReport;
  if (format === 'json') out(JSON.stringify(report));
  else if (format === 'text') out(shippedText(report).join('\n'));
  else {
    const files = format === 'md' ? [[SHIPPED_DOC_PATH, shippedMarkdown(report)]] : [[SHIPPED_SITE_JSON, `${JSON.stringify(report, null, 2)}\n`], [SHIPPED_SITE_PAGE, shippedPage(report)]];
    // An unreadable source never replaces a good page with an empty one.
    if (report.source === 'unknown') { err(`phm shipped: ${report.note ?? 'git history could not be read'}; ${files.map(([path]) => path).join(' and ')} ${files.length === 1 ? 'was' : 'were'} not changed`); return 1; }
    for (const [path, text] of files) {
      const file = join(root, path!);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text!);
      out(file);
    }
  }
  return report.source === 'unknown' ? 1 : 0;
}
