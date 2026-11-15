/**
 * `phm eval prompts` — RQ-SELFOPT-PROMPT-OPT prompt-variant A/B dashboard.
 *
 * Replays each prompt variant per job class over a frozen router-eval.v1
 * outcome log through the router-eval harness, and prints the before/after
 * table: control vs challenger merge rate, cost per merged PR and wall time.
 * A challenger is promoted only on a significant lift (disjoint Wilson 95%
 * intervals, minimum resolved cohort, bounded unobserved coverage, cost
 * guardrail). `--promote` writes the winners to the prompt-promotions
 * registry that `phm pulse` renders and `assignPromptVariant` routes on.
 *
 *   phm eval prompts --dataset jobs.jsonl [--spec experiment.json]
 *                    [--promote] [--write report.json] [--check promotions.json]
 *                    [--json]
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { parseRouterEvalDataset, type RouterEvalDataset } from '../core/eval/router-eval.js';
import {
  evaluatePromptExperiment,
  formatPromptAbMarkdown,
  promotionsRegistry,
  type PromptAbReport,
} from '../core/eval/prompt-ab.js';
import {
  loadPromptPromotions,
  mergePromotions,
  savePromptPromotions,
  type PromptPromotionsRegistry,
} from '../core/eval/prompt-promotions.js';
import {
  parsePromptExperimentSpec,
  type PromptExperimentSpec,
} from '../core/eval/prompt-variants.js';

const USAGE = `Usage: phm eval prompts --dataset <jobs.jsonl> [--spec <experiment.json>] [--promote] [--write <report.json>] [--check <promotions.json>] [--json]

  Replays prompt variants per job class over frozen outcome logs and prints
  the before/after A/B table. A variant is promoted only on a significant
  merge-rate lift under the gate (disjoint 95% intervals, minimum resolved
  cohort, bounded unobserved coverage, cost guardrail). --promote writes the
  winners to the prompt-promotions registry; --check exits 1 when the replay
  drifts from a committed promotions file.`;

export interface EvalPromptsCliDeps {
  readFile?: (path: string) => string;
  writeFile?: (path: string, text: string) => void;
  loadRegistry?: () => PromptPromotionsRegistry | null;
  saveRegistry?: (registry: PromptPromotionsRegistry) => string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: string;
}

interface ParsedArgs {
  dataset?: string;
  spec?: string;
  promote: boolean;
  json: boolean;
  write?: string;
  check?: string;
  usageError?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { promote: false, json: false };
  const valueFlags = new Set(['--dataset', '--spec', '--write', '--check']);
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { parsed.usageError = `repeated argument: ${arg}`; return parsed; }
    if (arg === '--json') { parsed.json = true; seen.add(arg); continue; }
    if (arg === '--promote') { parsed.promote = true; seen.add(arg); continue; }
    if (valueFlags.has(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) {
        parsed.usageError = `${arg} requires a value`;
        return parsed;
      }
      parsed[arg.slice(2) as 'dataset' | 'spec' | 'write' | 'check'] = value;
      seen.add(arg);
      continue;
    }
    parsed.usageError = `unknown argument: ${arg}`;
    return parsed;
  }
  return parsed;
}

/** The shipped experiment — class matchers and arms for the baked variants.
 * Parsed through parsePromptExperimentSpec so the match.task regexes compile. */
export const DEFAULT_PROMPT_EXPERIMENT: PromptExperimentSpec = parsePromptExperimentSpec({
  v: 1,
  id: 'prompt-ab-default',
  note: 'Builtin spec: docs/test/secrets job classes, plain vs adaptive prompts.',
  classes: [
    {
      id: 'docs',
      match: { task: 'docs|readme|changelog|copy|freshness|content' },
      control: 'prompt:plain',
      challengers: ['prompt:adaptive'],
    },
    {
      id: 'tests',
      match: { task: 'test|ci|flake|shard|vitest|regression' },
      control: 'prompt:plain',
      challengers: ['prompt:adaptive'],
    },
    {
      id: 'secrets',
      match: { task: 'secrets|rotation|credential|custody|attestation' },
      control: 'prompt:plain',
      challengers: ['prompt:adaptive'],
    },
  ],
});

/** Structural drift check against a committed promotions file — compares the
 * promoted/held verdicts and the metric values, not wall-clock fields. */
function registryDrift(current: PromptPromotionsRegistry, committed: PromptPromotionsRegistry): string[] {
  const diffs: string[] = [];
  const key = (p: { classId: string; variant: string }) => `${p.classId}→${p.variant}`;
  const cur = new Map(current.promoted.map((p) => [p.classId, p]));
  const old = new Map(committed.promoted.map((p) => [p.classId, p]));
  for (const [classId, prev] of old) {
    const now = cur.get(classId);
    if (!now) { diffs.push(`${classId}: was promoted to ${prev.variant}, now held`); continue; }
    if (now.variant !== prev.variant) diffs.push(`${classId}: winner ${prev.variant} -> ${now.variant}`);
    if (now.after.value !== prev.after.value) diffs.push(`${classId}: after mergeRate ${prev.after.value} -> ${now.after.value}`);
    if (now.before.value !== prev.before.value) diffs.push(`${classId}: before mergeRate ${prev.before.value} -> ${now.before.value}`);
  }
  for (const [classId, now] of cur) {
    if (!old.has(classId)) diffs.push(`${key(now)}: newly promoted`);
  }
  const heldKey = (h: { classId: string; variant: string; verdict: string }) => `${h.classId}→${h.variant}:${h.verdict}`;
  const curHeld = new Set(current.held.map(heldKey));
  for (const h of committed.held) {
    if (!curHeld.has(heldKey(h))) diffs.push(`held verdict drift: ${heldKey(h)}`);
  }
  return diffs;
}

export async function cmdEvalPrompts(args: string[], overrides: EvalPromptsCliDeps = {}): Promise<number> {
  const deps: Required<EvalPromptsCliDeps> = {
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, text) => writeFileSync(path, text),
    loadRegistry: () => loadPromptPromotions(),
    saveRegistry: (registry) => savePromptPromotions(registry),
    out: console.log,
    err: console.error,
    now: new Date().toISOString(),
    ...overrides,
  };
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { deps.out(USAGE); return 0; }
  const parsed = parseArgs(args);
  if (parsed.usageError) { deps.err(`error: ${parsed.usageError}\n${USAGE}`); return 2; }
  if (!parsed.dataset) { deps.err(`error: --dataset is required\n${USAGE}`); return 2; }

  let dataset: RouterEvalDataset;
  try {
    dataset = parseRouterEvalDataset(deps.readFile(parsed.dataset));
  } catch {
    // Dataset contents and paths may be private; do not echo them.
    deps.err('error: could not read or parse the router-eval dataset');
    return 1;
  }

  let spec: PromptExperimentSpec = DEFAULT_PROMPT_EXPERIMENT;
  if (parsed.spec !== undefined) {
    try {
      spec = parsePromptExperimentSpec(JSON.parse(deps.readFile(parsed.spec)));
    } catch {
      deps.err('error: could not read or parse the prompt experiment spec');
      return 1;
    }
  }

  const report: PromptAbReport = evaluatePromptExperiment(dataset, spec, { now: deps.now });
  const registry = promotionsRegistry(report);

  if (parsed.write !== undefined) {
    try {
      deps.writeFile(parsed.write, `${JSON.stringify(registry, null, 2)}\n`);
    } catch {
      deps.err('error: could not write the promotions file');
      return 1;
    }
  }

  if (parsed.promote) {
    try {
      deps.saveRegistry(mergePromotions(deps.loadRegistry(), registry));
    } catch {
      deps.err('error: could not write the prompt-promotions registry');
      return 1;
    }
  }

  if (parsed.check !== undefined) {
    let committed: PromptPromotionsRegistry;
    try {
      committed = JSON.parse(deps.readFile(parsed.check)) as PromptPromotionsRegistry;
    } catch {
      deps.err('error: could not read the committed promotions file');
      return 1;
    }
    const diffs = registryDrift(registry, committed);
    if (diffs.length > 0) {
      deps.err(`error: prompt-promotion regression — ${diffs.join('; ')}`);
      return 1;
    }
    deps.out(`prompt-ab: ${registry.promoted.length} promoted, ${registry.held.length} held — reproduces the committed promotions.`);
    return 0;
  }

  deps.out(parsed.json ? JSON.stringify({ ...report, registry }, null, 2) : formatPromptAbMarkdown(report).trimEnd());
  return 0;
}
