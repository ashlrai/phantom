/** `phm recut check`: is a recut or red-fix job worth launching? Read-only. */
import { join } from 'node:path';
import { RECUT_CHECK_SCHEMA, readRecutGateFacts, runGit, shouldEmitRecut, type GitRun } from '../core/fleet/recut-gate.js';
import { runsRoot } from '../core/metrics/loop-collect.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm recut check [--json] [--ref <branch>] [--base master] [--metrics <jobs.jsonl>] <area-or-job-id>';

export interface RecutCheckDeps { git?: GitRun; now?: number; output?: (text: string) => void; error?: (text: string) => void }

export async function cmdRecut(args: string[], deps: RecutCheckDeps = {}): Promise<number> {
  const output = deps.output ?? console.log, error = deps.error ?? console.error;
  const help = (arg?: string) => arg === '--help' || arg === '-h';
  if ((args.length === 1 && help(args[0])) || (args.length === 2 && args[0] === 'check' && help(args[1]))) {
    output(`${usage}
Should the next recut or red-fix job launch? Give an area (core, webui) or a job id
(RQ-PHX-RECUTCOREC566, RQ-PHX-REDTYPEFIXC459). Skip when:
  - its job kind is on the phm jobs yield --stop-list list,
  - its last 3 jobs ended empty and master has no new commits in that area since, or
  - --ref is already on master (empty diff, or every hunk already applied).
Unreadable yield data never skips: it launches with reason "yield unknown".
Exit 0: launch it. Exit 1: skip it. Exit 2: usage. JSON is ${RECUT_CHECK_SCHEMA} with version 1.`);
    return 0;
  }
  if (args[0] !== 'check') { error(usage); return 2; }
  let json = false, target: string | null = null, ref: string | null = null, base = 'master', metrics: string | null = null;
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('-') && seen.has(arg)) { error(usage); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--ref' || arg === '--base' || arg === '--metrics') {
      const value = args[++i];
      if (!value || value.startsWith('-')) { error(usage); return 2; }
      if (arg === '--ref') ref = value; else if (arg === '--base') base = value; else metrics = value;
    } else if (!arg.startsWith('-') && target === null) target = arg;
    else { error(usage); return 2; }
  }
  if (target === null) { error(usage); return 2; }
  const facts = await readRecutGateFacts(target, {
    metrics: metrics ?? join(runsRoot(), 'metrics', 'jobs.jsonl'), git: deps.git ?? runGit(process.cwd()),
    now: deps.now, base, ref,
  });
  if (!facts) { error(usage); return 2; }
  const decision = shouldEmitRecut(facts);
  if (json) {
    output(JSON.stringify(sanitizePublicJson({
      schema: RECUT_CHECK_SCHEMA, version: 1, target, family: facts.family, area: facts.area || null, ...decision,
      facts: { yield: facts.stopList === null ? 'unknown' : 'known', on_stop_list: facts.stopList === null ? null : facts.stopList.includes(facts.family),
        last_jobs: facts.lastJobs, since: facts.since, area_paths: facts.paths, master_touched: facts.masterTouched,
        base, ref: facts.ref, diff_contained: facts.diffContained },
    })));
  } else output(decision.emit ? `recut launch: ${decision.reason}` : `recut skipped: ${decision.reason}`);
  return decision.emit ? 0 : 1;
}
