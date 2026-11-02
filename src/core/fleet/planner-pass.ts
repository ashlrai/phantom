/** Bridge the declared planner slate to the canonical planner runtime. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPlannerCandidates } from './planner-candidates.js';
import { planPlannerPass, runPlannerPass } from './planner-run.js';

export interface PlannerPassDeps {
  readCandidates: typeof readPlannerCandidates;
  plan: typeof planPlannerPass;
  run: typeof runPlannerPass;
}
export const defaultPlannerPassDeps: PlannerPassDeps = {
  readCandidates: readPlannerCandidates, plan: planPlannerPass, run: runPlannerPass,
};
export interface PlannerPassOptions {
  runsRoot?: string;
  promptPath?: string;
  run?: boolean;
}
export async function executePlannerPass(opts: PlannerPassOptions, deps = defaultPlannerPassDeps) {
  const runsRoot = opts.runsRoot ?? join(homedir(), '.ashlr-runs');
  const slate = await deps.readCandidates(runsRoot);
  if (slate.source !== 'ok') return {
    ok: false, provider: null, reason: `planner candidates ${slate.source}`, nextResetAt: null,
  };
  const planOpts = { runsRoot, candidates: slate.candidates, lastProvider: slate.lastProvider ?? '' };
  const { choice, health } = await deps.plan(planOpts);
  if (!choice.ok) return { ...choice, provider: null };
  const reason = `first candidate not usage-limited; last provider health: ${health.status}${health.reason ? ` (${health.reason})` : ''}`;
  if (!opts.run) return { ok: true, provider: choice.provider, reason };
  if (!opts.promptPath) return { ok: false, provider: choice.provider, reason: '--run requires --prompt-file' };
  const result = await deps.run({ ...planOpts, promptPath: opts.promptPath });
  return {
    ok: result.outcome === 'ran' && result.exitCode === 0 || result.outcome === 'skipped-orch-off',
    provider: result.provider, reason, result,
  };
}
