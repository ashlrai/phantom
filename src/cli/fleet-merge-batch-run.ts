/** Snapshot → overlap plan → bounded next actions. JSON only; never invokes gh. */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { looksLikeOption } from './args.js';
import type { FleetMergeBatchDeps } from './fleet-merge-batch.js';
import { defaultSnapshotRoot, parseSnapshotJson, readPrSnapshot } from './fleet-pr-snapshot.js';
import { readRebaseCoverage } from './fleet-rebase-plan.js';
import { MAX_PRS, parseMergeBatchPrs, planMergeBatches } from '../core/fleet/merge-batch.js';
import { MERGE_BATCH_RUN_SCHEMA, runMergeBatch } from '../core/fleet/merge-batch-runner.js';
import { parseHoldList, type RebasePlanExistingJob } from '../core/fleet/rebase-plan.js';

export interface FleetMergeBatchRunDeps extends FleetMergeBatchDeps {
  existing?: readonly RebasePlanExistingJob[];
  hold?: ReadonlySet<string>;
}
const USAGE = `Usage: phm fleet merge-batch-run [--input <file>|-] [--repo <owner/name>] [--root <abs>] [--json]
Emit merge, rebase, close-review and wait actions from an open-PR snapshot.
Input: gh pr list JSON (include headRefOid and files), merge-backlog, or pr-hygiene.
Default input: piped stdin or <root>/fleet/open-prs.json. JSON output is the default.
Reads <root>/queue/{router-queue.md,ready.tsv,hold-list.txt} for coverage and holds.
No GitHub calls or writes. Dependencies require merged PRs and a fresh snapshot;
CI tiers are advisory and never replace required checks. Exit 1 for unusable input.`;

export async function cmdFleetMergeBatchRun(args: string[], deps: FleetMergeBatchRunDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { out(USAGE + '\n'); return 0; }
  let inputPath: string | null = null;
  let repo: string | null = null;
  let root = deps.root;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) { err(USAGE + '\n'); return 2; }
    seen.add(flag);
    if (flag === '--json') continue;
    const value = args[++i];
    if (!value || (looksLikeOption(value) && value !== '-')) { err(USAGE + '\n'); return 2; }
    if (flag === '--input') inputPath = value;
    else if (flag === '--repo' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(value)) repo = value;
    else if (flag === '--root' && isAbsolute(value)) root = value;
    else { err(USAGE + '\n'); return 2; }
  }
  const now = (deps.now ?? (() => new Date()))();
  const fail = (error: string): number => {
    out(JSON.stringify({ schema: MERGE_BATCH_RUN_SCHEMA, v: 1, repo, generatedAt: now.toISOString(),
      error, counts: { 'enqueue-merge': 0, rebase: 0, 'close-review': 0, wait: 0 }, actions: [] }) + '\n');
    return 1;
  };
  const read = await readPrSnapshot(inputPath, { ...deps, root });
  if (!read.ok) return fail(read.state);
  const json = parseSnapshotJson(read);
  if (!json.ok) return fail('malformed-json');
  const parsed = parseMergeBatchPrs(json.value);
  if (!parsed.ok) return fail('invalid-snapshot');
  if (parsed.upstream !== 'ok' && parsed.upstream !== 'healthy') return fail('upstream-failed');
  if (repo && parsed.repo && repo.toLowerCase() !== parsed.repo.toLowerCase()) return fail('repo-mismatch');
  repo = parsed.repo ?? repo;
  if (!repo) return fail('missing-repo');
  const envelope = json.value as { items?: unknown[]; complete?: boolean; error?: unknown };
  const rows: unknown[] = Array.isArray(json.value) ? json.value : envelope.items ?? [];
  if (rows.length > MAX_PRS || envelope.complete === false || envelope.error
    || parsed.unreadable > 0 || parsed.duplicates > 0) return fail('incomplete-snapshot');
  if (rows.some(row => {
    const pr = row as Record<string, unknown>;
    return (pr['state'] !== undefined && pr['state'] !== 'OPEN') || pr['mergedAt'] || pr['closedAt'];
  })) return fail('not-open-snapshot');
  const queue = join(defaultSnapshotRoot(root), 'queue');
  const readText = deps.readText ?? (async (path: string) => readFile(path, 'utf8'));
  const boundedRead = async (path: string): Promise<string> => {
    const text = await readText(path);
    if (text.length > 4 * 1024 * 1024) throw new Error('queue evidence too large');
    return text;
  };
  const coverage = deps.existing ? { state: 'ok' as const, jobs: deps.existing }
    : await readRebaseCoverage(queue, boundedRead);
  if (coverage.jobs.length > MAX_PRS) return fail('oversized-queue');
  let hold = deps.hold;
  let holdState = 'ok';
  if (!hold) {
    try { hold = parseHoldList(await boundedRead(join(queue, 'hold-list.txt'))); }
    catch { holdState = 'missing'; }
  }
  const plan = planMergeBatches({ ...parsed, repo, now });
  const report = runMergeBatch({ plan, prs: parsed.prs, existing: coverage.jobs, hold });
  out(JSON.stringify({ ...report, input: { kind: parsed.kind, source: read.source, state: 'ok' },
    sources: { queue: coverage.state, hold: holdState } }) + '\n');
  return 0;
}
