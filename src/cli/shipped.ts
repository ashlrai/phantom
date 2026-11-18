/** `phm shipped`: thin handler. Parses argv and prints the report built in core/release/shipped.ts. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildShipped, gitShippedSource, SHIPPED_DOC_PATH, shippedMarkdown, shippedText, type ShippedReport, type ShippedSource } from '../core/release/shipped.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm shipped [--since 7d] [--json|--md]
What shipped, in plain words: merged changes on the default branch, grouped by product area
(desktop app, CLI, fleet, channels, docs). Test-only and bot chore changes are counted as maintenance.
Reads local git history only; no network.
  --since <n>d   days to cover, 1d to 90d, default 7d
  --json         print the report as JSON (schema shipped.v1, version 1)
  --md           write ${SHIPPED_DOC_PATH} in this repository and print its path
Anything that could not be read prints as "unknown" (text) or null (JSON), never as zero.
Exit 0 ok, 1 when git history could not be read, 2 usage.`;

export interface ShippedDeps { now?: () => number; out?: (line: string) => void; err?: (line: string) => void; root?: string; source?: ShippedSource }

function repoRoot(): string {
  const run = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return run.status === 0 && run.stdout.trim() ? run.stdout.trim() : process.cwd();
}

export async function cmdShipped(args: string[], deps: ShippedDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  let days = 7, format: 'text' | 'json' | 'md' = 'text';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' || arg === '--md') {
      if (format !== 'text' && format !== arg.slice(2)) { err(`phm shipped: choose one of --json or --md\n${usage}`); return 2; }
      format = arg === '--json' ? 'json' : 'md';
    } else if (arg === '--since') {
      const match = /^(\d{1,2})d$/.exec(args[++i] ?? '');
      days = match ? Number(match[1]) : NaN;
      if (!(days >= 1 && days <= 90)) { err(`phm shipped: --since takes a number of days such as 7d\n${usage}`); return 2; }
    } else { err(`phm shipped: unknown option ${arg}\n${usage}`); return 2; }
  }
  const root = deps.root ?? repoRoot();
  const now = (deps.now ?? Date.now)();
  // Scrubbed once here, so the JSON, the text and the page can never differ in what they reveal.
  const report = sanitizePublicJson(buildShipped(await (deps.source ?? gitShippedSource(root))(now - days * 86_400_000), { now, days })) as ShippedReport;
  if (format === 'json') out(JSON.stringify(report));
  else if (format === 'md') {
    // An unreadable source never replaces a good page with an empty one.
    if (report.source === 'unknown') { err(`phm shipped: ${report.note ?? 'git history could not be read'}; ${SHIPPED_DOC_PATH} was not changed`); return 1; }
    const file = join(root, SHIPPED_DOC_PATH);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, shippedMarkdown(report));
    out(file);
  } else out(shippedText(report).join('\n'));
  return report.source === 'unknown' ? 1 : 0;
}
