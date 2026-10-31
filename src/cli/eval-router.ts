/**
 * `phm eval router` — RQ-SELFOPT-EVAL-HARNESS offline router-policy eval.
 *
 * Replays a policy over a frozen router-eval.v1 dataset of past router lines
 * with known outcomes, and reports merge rate, cost per merged PR and wall
 * time with confidence intervals. Fully offline and hermetic: no credentials,
 * model calls, provider probes or mutable state. `--check` turns it into the
 * regression gate the daily master run pins.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import {
  BUILTIN_ROUTER_POLICIES,
  builtinRouterPolicy,
  evaluateRouterPolicy,
  formatRouterEvalMarkdown,
  parseRouterEvalDataset,
  type RouterEvalDataset,
  type RouterEvalReport,
} from '../core/eval/router-eval.js';

const USAGE = `Usage: phm eval router --dataset <jobs.jsonl> [--policy <name>] [--decisions] [--json] [--write <report.json>] [--check <baseline.json>]

  Replays a router or prompt policy over frozen router lines with known
  outcomes and reports merge rate, cost per merged PR and wall time with
  confidence intervals. Policies: ${BUILTIN_ROUTER_POLICIES.join(', ')}.
  --check exits 1 when the replayed metrics drift from the baseline report.`;

export interface EvalRouterCliDeps {
  readFile?: (path: string) => string;
  writeFile?: (path: string, text: string) => void;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

interface ParsedArgs {
  dataset?: string;
  policy: string;
  listPolicies: boolean;
  json: boolean;
  decisions: boolean;
  write?: string;
  check?: string;
  usageError?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { policy: 'logged', listPolicies: false, json: false, decisions: false };
  const valueFlags = new Set(['--dataset', '--policy', '--write', '--check']);
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { parsed.usageError = `repeated argument: ${arg}`; return parsed; }
    if (arg === '--json') { parsed.json = true; seen.add(arg); continue; }
    if (arg === '--decisions') { parsed.decisions = true; seen.add(arg); continue; }
    if (arg === '--policy' && args[i + 1] === 'list') { parsed.listPolicies = true; i++; continue; }
    if (valueFlags.has(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) {
        parsed.usageError = `${arg} requires a value`;
        return parsed;
      }
      parsed[arg.slice(2) as 'dataset' | 'policy' | 'write' | 'check'] = value;
      seen.add(arg);
      continue;
    }
    parsed.usageError = `unknown argument: ${arg}`;
    return parsed;
  }
  return parsed;
}

/** Structural equality on everything but the optional decision table; the
 * table is compared too when both reports carry one. */
function reportsDiffer(a: RouterEvalReport, b: RouterEvalReport): string[] {
  const strip = (r: RouterEvalReport) => JSON.stringify({ ...r, decisions: undefined });
  const diffs: string[] = [];
  if (strip(a) !== strip(b)) {
    if (a.dataset?.sha256 !== b.dataset?.sha256) diffs.push(`dataset sha256 ${String(b.dataset?.sha256).slice(0, 12)} -> ${a.dataset.sha256.slice(0, 12)}`);
    if (a.policy !== b.policy) diffs.push(`policy ${b.policy} -> ${a.policy}`);
    for (const key of ['mergeRate', 'costPerMergedPrUsd', 'tokensPerMergedPr', 'wallTimeMsMean'] as const) {
      if (a[key]?.value !== b[key]?.value) diffs.push(`${key} ${b[key]?.value} -> ${a[key].value}`);
    }
    if (diffs.length === 0) diffs.push('report structure differs (coverage, per-arm or bootstrap fields)');
  }
  if (a.decisions !== undefined && b.decisions !== undefined
    && JSON.stringify(a.decisions) !== JSON.stringify(b.decisions)) {
    diffs.push('decision table differs');
  }
  return diffs;
}

export async function cmdEvalRouter(args: string[], overrides: EvalRouterCliDeps = {}): Promise<number> {
  const deps: Required<EvalRouterCliDeps> = {
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, text) => writeFileSync(path, text),
    out: console.log,
    err: console.error,
    ...overrides,
  };
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { deps.out(USAGE); return 0; }
  const parsed = parseArgs(args);
  if (parsed.usageError) { deps.err(`error: ${parsed.usageError}\n${USAGE}`); return 2; }
  if (parsed.listPolicies) { deps.out(BUILTIN_ROUTER_POLICIES.join('\n')); return 0; }
  if (!parsed.dataset) { deps.err(`error: --dataset is required\n${USAGE}`); return 2; }

  let dataset: RouterEvalDataset;
  try {
    dataset = parseRouterEvalDataset(deps.readFile(parsed.dataset));
  } catch {
    // Dataset contents and paths may be private; do not echo them.
    deps.err('error: could not read or parse the router-eval dataset');
    return 1;
  }
  const policy = builtinRouterPolicy(parsed.policy, dataset.jobs);
  if (!policy) {
    deps.err(`error: unknown policy '${parsed.policy}' — builtin policies: ${BUILTIN_ROUTER_POLICIES.join(', ')}`);
    return 2;
  }
  const report = evaluateRouterPolicy(dataset, policy, { includeDecisions: parsed.decisions });

  if (parsed.write !== undefined) {
    try {
      deps.writeFile(parsed.write, `${JSON.stringify(report, null, 2)}\n`);
    } catch {
      deps.err('error: could not write the report file');
      return 1;
    }
  }

  if (parsed.check !== undefined) {
    let baseline: RouterEvalReport;
    try {
      baseline = JSON.parse(deps.readFile(parsed.check)) as RouterEvalReport;
    } catch {
      deps.err('error: could not read the baseline report');
      return 1;
    }
    const diffs = reportsDiffer(report, baseline);
    if (diffs.length > 0) {
      deps.err(`error: router-eval regression — ${diffs.join('; ')}`);
      return 1;
    }
    deps.out(`router-eval: policy '${report.policy}' reproduces the baseline (${report.coverage.jobs} jobs, merge rate ${report.mergeRate.value}).`);
    return 0;
  }

  deps.out(parsed.json ? JSON.stringify(report, null, 2) : formatRouterEvalMarkdown(report).trimEnd());
  return 0;
}
