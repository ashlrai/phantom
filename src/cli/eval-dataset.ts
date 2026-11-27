/**
 * `phm eval dataset` — fold the live fleet ledgers into a router-eval.v1
 * dataset for `phm eval router` / `phm eval prompts`.
 *
 * Reads <runsDir>/metrics/jobs.jsonl (+ api-spend, work-market,
 * empty-tags, merge-events) through the same bounded, unknown-preserving
 * fold `phm router outcomes` uses, maps each job onto a dataset line
 * (src/core/eval/router-dataset.ts) and writes the JSONL. Real outcomes
 * only: counterfactual arms are never invented, so a replayed policy
 * that changes a decision counts it unobserved — the same honesty rule
 * the frozen benchmark keeps. Read-only; writes only the --out file.
 */

import { writeFileSync } from 'node:fs';

import { foldRouterEvalDataset, routerEvalDatasetText } from '../core/eval/router-dataset.js';
import { readRouterOutcomes, type RouterOutcomeRead } from '../core/router/outcomes.js';
import { isEvalHelpRequest, parseEvalCliFlags } from './eval-args.js';

const USAGE = `Usage: phm eval dataset [--runs-dir <dir>] [--lane <lane>] [--out <jobs.jsonl>] [--json]

  Folds the fleet outcome ledgers into a router-eval.v1 dataset that
  'phm eval router' and 'phm eval prompts' can replay. Prints the dataset
  JSONL to stdout unless --out is given; --json prints the fold summary
  (source states and outcome counts) instead.`;

export interface EvalDatasetCliDeps {
  readOutcomes?: (opts: { runsDir?: string; lane?: string; authorityEvidence?: null }) => Promise<RouterOutcomeRead>;
  writeFile?: (path: string, text: string) => void;
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: () => Date;
}

export async function cmdEvalDataset(args: string[], overrides: EvalDatasetCliDeps = {}): Promise<number> {
  const deps: Required<EvalDatasetCliDeps> = {
    readOutcomes: (opts) => readRouterOutcomes({ ...opts, authorityEvidence: null }),
    writeFile: (path, text) => writeFileSync(path, text),
    out: console.log,
    err: console.error,
    now: () => new Date(),
    ...overrides,
  };
  if (isEvalHelpRequest(args)) { deps.out(USAGE); return 0; }
  const { booleans, values, usageError } = parseEvalCliFlags(args, {
    booleans: { '--json': 'json' },
    values: { '--runs-dir': 'runsDir', '--lane': 'lane', '--out': 'out' },
  });
  if (usageError) { deps.err(`error: ${usageError}\n${USAGE}`); return 2; }

  let read: RouterOutcomeRead;
  try {
    read = await deps.readOutcomes({ runsDir: values.runsDir, lane: values.lane });
  } catch {
    deps.err('error: could not read the fleet outcome ledgers');
    return 1;
  }
  if (read.state !== 'read') {
    deps.err(`error: jobs ledger ${read.state} — no dataset to fold`);
    return 1;
  }

  const computation = foldRouterEvalDataset(read.outcomes);
  const text = routerEvalDatasetText(computation, deps.now());

  if (values.out !== undefined) {
    try {
      deps.writeFile(values.out, text);
    } catch {
      deps.err('error: could not write the dataset file');
      return 1;
    }
  }

  if (booleans.json) {
    deps.out(JSON.stringify({
      schema: 'phm.eval-dataset.v1',
      jobs: computation.jobs.length,
      unattributed: computation.unattributed,
      counts: computation.counts,
      sources: {
        jobs: { state: read.state, truncated: read.truncated },
        spend: { state: read.spend_state, truncated: read.spend_truncated },
        market: { state: read.market_state, truncated: read.market_truncated },
        emptyTags: { state: read.empty_tag_state, truncated: read.empty_tag_truncated },
        mergeEvents: { state: read.merge_events_state, truncated: read.merge_events_truncated },
        reward: { state: read.reward_state, truncated: read.reward_truncated },
        launchCost: { state: read.launch_cost_state, truncated: read.launch_cost_truncated },
        revertLedger: read.revert_ledger_state,
      },
      written: values.out ?? null,
    }, null, 2));
    return 0;
  }

  if (values.out === undefined) deps.out(text.trimEnd());
  else deps.out(`wrote ${computation.jobs.length} job lines to ${values.out}`);
  return 0;
}
