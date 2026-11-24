/**
 * `phm recut check | plan | prompt`: should recut jobs launch, and what must their prompts start with?
 * check and plan only read; prompt only transforms stdin to stdout.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { RECUT_AREAS, RECUT_CHECK_SCHEMA, readRecutGateFacts, recutTarget, runGit, shouldEmitRecut, type GitRun, type RecutGateDecision } from '../core/fleet/recut-gate.js';
import { RECUT_PLAN_SCHEMA, planRecutArea, promptTask, recutTaskLine, withTaskLine, type RecutPrList } from '../core/fleet/recut-plan.js';
import { readLiveStops, stopFilePath } from '../core/fleet/stop-file.js';
import { runsRoot } from '../core/metrics/loop-collect.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { cmdFleetDirtyLanded, type DirtyLandedReport } from './fleet-dirty-landed.js';

const checkUsage = 'Usage: phm recut check [--json] [--ref <branch>] [--base master] [--metrics <jobs.jsonl>] <area-or-job-id>';
const planUsage = 'Usage: phm recut plan [--json] [--prs <dirty-landed.json>] [--base master] [--metrics <jobs.jsonl>] [<area>...]';
const promptUsage = 'Usage: phm recut prompt <job-id> --lane <lane> --tier <tier> [--repo phantom] [--task <text>] < prompt.md';
const usage = [checkUsage, planUsage, promptUsage].join('\n');
const MAX_PROMPT_BYTES = 256 * 1024;

export interface RecutCheckDeps {
  git?: GitRun; now?: number; output?: (text: string) => void; error?: (text: string) => void;
  /** gh reader for the default PR list (`phm fleet dirty-landed`). */
  gh?: CloudGh;
  /** The prompt for `recut prompt`; defaults to stdin. */
  input?: () => Promise<string>;
}

const isHelp = (arg?: string) => arg === '--help' || arg === '-h';

export async function cmdRecut(args: string[], deps: RecutCheckDeps = {}): Promise<number> {
  const output = deps.output ?? console.log, error = deps.error ?? console.error;
  const [verb, ...rest] = args;
  if (args.length === 1 && isHelp(verb)) { output(usage); return 0; }
  if (verb === 'check') return recutCheck(rest, deps, output, error);
  if (verb === 'plan') return recutPlan(rest, deps, output, error);
  if (verb === 'prompt') return recutPrompt(rest, deps, output, error);
  error(usage);
  return 2;
}

/** Shared flag reader: value flags take one value, `--json` is a switch, the rest are positionals. Null on bad usage. */
function parse(args: string[], valueFlags: readonly string[]): { json: boolean; values: Map<string, string>; positional: string[] } | null {
  let json = false;
  const values = new Map<string, string>(), positional: string[] = [], seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('-') && seen.has(arg)) return null;
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (valueFlags.includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) return null;
      values.set(arg, value);
    } else if (!arg.startsWith('-')) positional.push(arg);
    else return null;
  }
  return { json, values, positional };
}

const metricsPath = (value: string | undefined) => value ?? join(runsRoot(), 'metrics', 'jobs.jsonl');

async function recutCheck(args: string[], deps: RecutCheckDeps, output: (t: string) => void, error: (t: string) => void): Promise<number> {
  if (args.length === 1 && isHelp(args[0])) {
    output(`${checkUsage}
Should the next recut or red-fix job launch? Give an area (core, webui) or a job id
(RQ-PHX-RECUTCOREC566, RQ-PHX-REDTYPEFIXC459). Skip when:
  - its job kind is on the phm jobs yield --stop-list list,
  - a live row in the job stop file (phm jobs yield --stop-file) matches it,
  - its last 3 jobs ended empty and master has no new commits in that area since, or
  - --ref is already on master (empty diff, or every hunk already applied).
Unreadable yield data never skips: it launches with reason "yield unknown".
Exit 0: launch it. Exit 1: skip it. Exit 2: usage. JSON is ${RECUT_CHECK_SCHEMA} with version 1.`);
    return 0;
  }
  const flags = parse(args, ['--ref', '--base', '--metrics']);
  if (!flags || flags.positional.length !== 1) { error(checkUsage); return 2; }
  const target = flags.positional[0]!, base = flags.values.get('--base') ?? 'master';
  const facts = await readRecutGateFacts(target, {
    metrics: metricsPath(flags.values.get('--metrics')), git: deps.git ?? runGit(process.cwd()),
    now: deps.now, base, ref: flags.values.get('--ref') ?? null,
  });
  if (!facts) { error(checkUsage); return 2; }
  const decision = shouldEmitRecut(facts);
  if (flags.json) {
    output(JSON.stringify(sanitizePublicJson({
      schema: RECUT_CHECK_SCHEMA, version: 1, target, family: facts.family, area: facts.area || null, ...decision,
      facts: { yield: facts.stopList === null ? 'unknown' : 'known', on_stop_list: facts.stopList === null ? null : facts.stopList.includes(facts.family),
        last_jobs: facts.lastJobs, since: facts.since, area_paths: facts.paths, master_touched: facts.masterTouched,
        base, ref: facts.ref, diff_contained: facts.diffContained, stop_file_row: facts.stopRow ?? null },
    })));
  } else output(decision.emit ? `recut launch: ${decision.reason}` : `recut skipped: ${decision.reason}`);
  return decision.emit ? 0 : 1;
}

/** A saved `fleet.dirty-landed.v1` report, or a fresh read. Unknown (null prs) on any failure. */
async function readPrList(file: string | undefined, deps: RecutCheckDeps, now: number): Promise<RecutPrList & { source: 'file' | 'gh' }> {
  const source = file ? 'file' as const : 'gh' as const;
  try {
    let text = '';
    if (file) text = await readFile(file, 'utf8');
    else if (await cmdFleetDirtyLanded(['--json'], { gh: deps.gh, output: t => { text = t; }, now: () => new Date(now) }) !== 0) {
      return { source, prs: null, complete: false };
    }
    const report = JSON.parse(text) as DirtyLandedReport;
    if (report?.schema !== 'fleet.dirty-landed.v1' || !Array.isArray(report.prs)) return { source, prs: null, complete: false };
    // Saved reports are data too. A malformed row cannot prove zero eligible work.
    if (!report.prs.every(pr => pr && typeof pr === 'object' && Number.isSafeInteger(pr.number)
      && typeof pr.title === 'string' && typeof pr.head === 'string' && typeof pr.base === 'string'
      && ['landed', 'partly-landed', 'needs-recut', 'unknown'].includes(pr.class)
      && Array.isArray(pr.remainingPaths) && pr.remainingPaths.every(path => typeof path === 'string'))) {
      return { source, prs: null, complete: false };
    }
    return { source, prs: report.prs, complete: report.complete === true };
  } catch { return { source, prs: null, complete: false }; }
}

async function recutPlan(args: string[], deps: RecutCheckDeps, output: (t: string) => void, error: (t: string) => void): Promise<number> {
  if (args.length === 1 && isHelp(args[0])) {
    output(`${planUsage}
Which recut areas should get a job this cycle? For each area (default: all ${RECUT_AREAS.length}) it prints emit or
skip and one plain reason. An area is skipped when phm recut check would skip it (stop list, a live
stop-file row, an empty streak) or when no eligible PR touches it. Eligible PRs come from the list the
recut worker scans: phm fleet dirty-landed (or --prs, a saved --json report of it), filtered the way
phm fleet recut-sweep filters. An unreadable PR list is unknown and never skips. Writes nothing.
Exit 0, or 2 for bad usage. JSON is ${RECUT_PLAN_SCHEMA} with version 1.`);
    return 0;
  }
  const flags = parse(args, ['--prs', '--base', '--metrics']);
  const areas = flags?.positional.map(arg => recutTarget(arg)) ?? [];
  if (!flags || areas.some(t => !t || !RECUT_AREAS.includes(t.area))) { error(planUsage); return 2; }
  const now = deps.now ?? Date.now(), base = flags.values.get('--base') ?? 'master';
  const metrics = metricsPath(flags.values.get('--metrics')), git = deps.git ?? runGit(process.cwd());
  const list = await readPrList(flags.values.get('--prs'), deps, now);
  const stopFile = stopFilePath();
  const stops = await readLiveStops(stopFile, now);
  const rows = [];
  for (const area of areas.length ? [...new Set(areas.map(t => t!.area))] : RECUT_AREAS) {
    const facts = await readRecutGateFacts(area.toLowerCase(), { metrics, git, now, base, stopFile });
    const gate: RecutGateDecision = facts ? shouldEmitRecut(facts) : { emit: true, code: 'yield-unknown', reason: 'yield unknown' };
    rows.push(planRecutArea(area, facts?.family ?? `RQ-PHX-RECUT${area}`, gate, list, now));
  }
  const emit = rows.filter(row => row.emit).length;
  if (flags.json) {
    output(JSON.stringify(sanitizePublicJson({
      schema: RECUT_PLAN_SCHEMA, version: 1, generated_at: new Date(now).toISOString(),
      emit, skip: rows.length - emit,
      prs: { source: list.source, known: list.prs !== null, complete: list.prs === null ? null : list.complete },
      stop_file: stopFile === null ? 'unset' : stops === null ? 'unreadable' : 'read',
      areas: rows,
    })));
  } else {
    for (const row of rows) output(`${row.emit ? 'emit' : 'skip'} ${row.area}: ${row.reason}`);
  }
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_PROMPT_BYTES) throw new Error('prompt too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function recutPrompt(args: string[], deps: RecutCheckDeps, output: (t: string) => void, error: (t: string) => void): Promise<number> {
  if (args.length === 1 && isHelp(args[0])) {
    output(`${promptUsage}
Reads a recut prompt on stdin and prints it with the standard task line first:
  <job-id> (P1, pool=<lane>, tier=<tier>, repo=<repo>): <task>
The fleet's launch precheck and stop list only see a job through that line. The task is --task,
else the prompt's first line without "#" or "Goal:". The rest of the prompt is unchanged; a prompt
that already starts with the line is printed as it is. Exit 0, or 2 for bad usage or input.`);
    return 0;
  }
  const flags = parse(args, ['--lane', '--tier', '--repo', '--task']);
  const lane = flags?.values.get('--lane'), tier = flags?.values.get('--tier');
  if (!flags || flags.json || flags.positional.length !== 1 || !lane || !tier) { error(promptUsage); return 2; }
  const id = flags.positional[0]!;
  let prompt: string;
  try { prompt = await (deps.input ?? readStdin)(); } catch { error('recut prompt: could not read the prompt on stdin'); return 2; }
  const task = flags.values.get('--task') ?? promptTask(prompt);
  if (!task) { error('recut prompt: the prompt is empty; give --task or a prompt'); return 2; }
  const line = recutTaskLine({ id, lane, tier, repo: flags.values.get('--repo') ?? 'phantom', task });
  if (!line) { error(`recut prompt: no valid task line (job id, lane, tier and repo are plain words; the task needs 16 or more characters). ${promptUsage}`); return 2; }
  const text = withTaskLine(prompt, line, id);
  output(text.endsWith('\n') ? text.slice(0, -1) : text);
  return 0;
}
