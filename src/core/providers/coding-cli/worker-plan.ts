/**
 * Plan a worker pass over labelled issues. Dry-run returns the plan and does
 * not invoke a runner. Execution builds a worktree and a draft PR through the
 * injected runner. Subscription, local, loopback and metered backends are
 * produce-only.
 */

import { roleAllowed, type DispatchRole } from '../../routing/backend-roles.js';
import type { BillingClass } from '../../routing/billing-class.js';
import { adapterById } from './adapters.js';
import type { CodingCliCatalog } from './catalog.js';
import { scrubAdapterEnv } from './env.js';
import { cooldownActive, type CliCooldown } from './limits.js';
import type { CliResult, CliRunner } from './probe.js';

export const ROUTE_LABELS = ['route:codex', 'route:claude', 'route:grok', 'route:any'] as const;
export type RouteLabel = (typeof ROUTE_LABELS)[number];

export interface IssueJob {
  number: number;
  title: string;
  body: string;
  labels: readonly string[];
}

export interface WorkerPlanStep {
  number: number;
  title: string;
  action: 'run' | 'skip';
  reason: string;
  route: RouteLabel | null;
  backend: string | null;
  billing: BillingClass | null;
  model: string | null;
  role: DispatchRole | null;
  worktree: string | null;
  pullRequest: 'draft' | null;
}

export interface WorkerPlan {
  dryRun: boolean;
  meteredEnabled: boolean;
  steps: WorkerPlanStep[];
}

export interface PlanInput {
  catalog: CodingCliCatalog;
  issues: readonly IssueJob[];
  repo: string;
  nowMs: number;
  meteredEnabled?: boolean;
  inFlight?: Readonly<Record<string, number>>;
  cooldowns?: readonly CliCooldown[];
  /** Accepted model names, keyed by backend. Unlisted names stay off the argv. */
  acceptedModels?: Readonly<Record<string, string>>;
}

const ROUTE_BACKEND: Readonly<Record<Exclude<RouteLabel, 'route:any'>, string>> = {
  'route:codex': 'codex',
  'route:claude': 'claude',
  'route:grok': 'grok',
};

function routeOf(labels: readonly string[]): RouteLabel | 'ambiguous' | null {
  const found = labels.filter((label): label is RouteLabel => (ROUTE_LABELS as readonly string[]).includes(label));
  if (found.length > 1) return 'ambiguous';
  return found[0] ?? null;
}

function skip(issue: IssueJob, reason: string, route: RouteLabel | null = null): WorkerPlanStep {
  return {
    number: issue.number,
    title: issue.title,
    action: 'skip',
    reason,
    route,
    backend: null,
    billing: null,
    model: null,
    role: null,
    worktree: null,
    pullRequest: null,
  };
}

/**
 * Label-pinned issues choose that adapter when billing, concurrency and
 * cooldown allow it. `route:any` waits for the seat-router policy pass.
 */
export function planWorker(input: PlanInput): WorkerPlan {
  const meteredEnabled = input.meteredEnabled === true || input.catalog.meteredEnabledByDefault;
  const inFlight = { ...(input.inFlight ?? {}) };
  const steps: WorkerPlanStep[] = [];
  for (const issue of input.issues) {
    const route = routeOf(issue.labels);
    if (route === null) {
      steps.push(skip(issue, 'no route label'));
      continue;
    }
    if (route === 'ambiguous') {
      steps.push(skip(issue, 'more than one route label'));
      continue;
    }
    if (route === 'route:any') {
      steps.push(skip(issue, 'route:any waits for the seat-router policy pass', route));
      continue;
    }
    const backend = ROUTE_BACKEND[route];
    const record = input.catalog.backends[backend];
    const adapter = adapterById(input.catalog, backend);
    if (!record || !adapter) {
      steps.push(skip(issue, `no adapter for ${backend}`, route));
      continue;
    }
    if (record.billing === 'metered' && !meteredEnabled) {
      steps.push(skip(issue, 'metered backend is disabled until explicitly enabled', route));
      continue;
    }
    if (!roleAllowed(record.billing, 'produce')) {
      steps.push(skip(issue, 'produce role refused', route));
      continue;
    }
    const cap = input.catalog.concurrency[backend] ?? 1;
    if ((inFlight[backend] ?? 0) >= cap) {
      steps.push(skip(issue, `concurrency cap ${cap} is full`, route));
      continue;
    }
    const cooled = (input.cooldowns ?? []).find((row) => row.backend === backend) ?? null;
    if (cooldownActive(cooled, input.nowMs)) {
      steps.push(skip(issue, cooled?.reason ?? 'backend is in cooldown', route));
      continue;
    }
    const model = input.acceptedModels?.[backend] ?? null;
    inFlight[backend] = (inFlight[backend] ?? 0) + 1;
    steps.push({
      number: issue.number,
      title: issue.title,
      action: 'run',
      reason: model ? 'pinned route, account-verified model' : 'pinned route, CLI default model (no named model is account-verified)',
      route,
      backend,
      billing: record.billing,
      model,
      role: 'produce',
      worktree: `${input.repo}/.phantom-worktrees/issue-${issue.number}`,
      pullRequest: 'draft',
    });
  }
  return { dryRun: true, meteredEnabled, steps };
}

export function parseIssues(text: string): IssueJob[] {
  const json = JSON.parse(text) as unknown;
  if (!Array.isArray(json)) throw new Error('issues file must be an array');
  return json.map((row, index) => {
    if (typeof row !== 'object' || row === null) throw new Error(`issues[${index}] must be an object`);
    const issue = row as Record<string, unknown>;
    if (typeof issue['number'] !== 'number' || !Number.isInteger(issue['number']) || issue['number'] < 1) {
      throw new Error(`issues[${index}].number must be a positive integer`);
    }
    if (typeof issue['title'] !== 'string' || issue['title'].trim() === '') throw new Error(`issues[${index}].title is required`);
    if (typeof issue['body'] !== 'string') throw new Error(`issues[${index}].body must be a string`);
    if (!Array.isArray(issue['labels']) || issue['labels'].some((label) => typeof label !== 'string')) {
      throw new Error(`issues[${index}].labels must be strings`);
    }
    return {
      number: issue['number'],
      title: issue['title'].trim(),
      body: issue['body'],
      labels: issue['labels'] as string[],
    };
  });
}

export function formatPlan(plan: WorkerPlan): string {
  const lines = [`worker plan (${plan.dryRun ? 'dry-run' : 'execute'})`, `metered: ${plan.meteredEnabled ? 'enabled' : 'disabled'}`, `steps: ${plan.steps.length}`];
  for (const step of plan.steps) {
    lines.push(`#${step.number} ${step.title}`);
    lines.push(`  action: ${step.action}`);
    lines.push(`  reason: ${step.reason}`);
    if (step.backend) lines.push(`  backend: ${step.backend}`);
    if (step.billing) lines.push(`  billing: ${step.billing}`);
    if (step.role) lines.push(`  role: ${step.role}`);
    if (step.model) lines.push(`  model: ${step.model}`);
    if (step.worktree) lines.push(`  worktree: ${step.worktree}`);
    if (step.pullRequest) lines.push(`  pr: ${step.pullRequest}`);
  }
  return lines.join('\n');
}

export interface SecretLookup {
  /** Return the secret or null. Callers must not log or interpolate the value. */
  get(name: string): string | null;
}

export interface ExecuteResult {
  number: number;
  ok: boolean;
  detail: string;
  /** Names the runner was asked to spawn, in order. Never secret values. */
  commands: string[];
}

function goalText(issue: IssueJob): string {
  const body = issue.body.trim();
  return body ? `${issue.title}\n\n${body}` : issue.title;
}

/**
 * Run one planned step. Draft PR only. The runner sees a scrubbed environment.
 * Devin consults the secret lookup and records only whether a key was present.
 */
export async function executeStep(
  step: WorkerPlanStep,
  issue: IssueJob,
  catalog: CodingCliCatalog,
  runner: CliRunner,
  sourceEnv: NodeJS.ProcessEnv,
  secrets: SecretLookup,
): Promise<ExecuteResult> {
  const commands: string[] = [];
  const fail = (detail: string): ExecuteResult => ({ number: step.number, ok: false, detail, commands });
  if (step.action !== 'run' || !step.backend || !step.worktree || step.role !== 'produce') {
    return fail(step.reason || 'step is not runnable');
  }
  if (!step.billing || !roleAllowed(step.billing, 'produce')) return fail('produce role refused');
  if (roleAllowed(step.billing, 'merge')) return fail('refusing a backend that would hold merge authority');
  if (roleAllowed(step.billing, 'credential')) return fail('refusing a backend that would hold a credential role');
  if (step.pullRequest !== 'draft') return fail('worker opens draft PRs only');
  const adapter = adapterById(catalog, step.backend);
  if (!adapter) return fail('adapter missing');
  if (step.backend === 'devin') {
    const name = catalog.backends.devin?.secretName ?? 'DEVIN_API_KEY';
    const present = secrets.get(name) !== null;
    return fail(present ? 'Devin dispatch is stubbed. A key is present and was not logged.' : 'Devin dispatch is stubbed. No key is configured.');
  }
  if (step.backend === 'cursor' || step.backend === 'ollama' || !adapter.bin || adapter.execArgs('', '', null).length === 0) {
    return fail(`${step.backend} execution is stubbed on this worker`);
  }
  const env = scrubAdapterEnv(sourceEnv);
  const branch = `phantom/issue-${step.number}`;
  const worktreeArgs = ['worktree', 'add', '-b', branch, step.worktree, 'HEAD'];
  commands.push(`git ${worktreeArgs.join(' ')}`);
  const worktree: CliResult = await runner.run('git', worktreeArgs, env);
  if (worktree.code !== 0) return fail('git worktree add failed');
  const execArgs = adapter.execArgs(goalText(issue), step.worktree, step.model);
  commands.push(`${adapter.bin} ${execArgs.map((arg) => (arg.includes(' ') ? '<goal>' : arg)).join(' ')}`);
  const run = await runner.run(adapter.bin, execArgs, env);
  if (run.code !== 0) return fail('adapter exec failed');
  const prArgs = ['pr', 'create', '--draft', '--title', issue.title, '--body', issue.body || issue.title];
  commands.push(`gh ${prArgs.join(' ')}`);
  if (prArgs.includes('merge') || !prArgs.includes('--draft')) return fail('PR command was not draft-only');
  const pr = await runner.run('gh', prArgs, env);
  if (pr.code !== 0) return fail('draft PR create failed');
  return { number: step.number, ok: true, detail: 'draft PR requested', commands };
}
