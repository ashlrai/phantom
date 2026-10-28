/**
 * Plan a worker pass over labelled issues. Dry-run returns the plan and does
 * not invoke a runner. Execution builds a worktree and a draft PR through the
 * injected runner. Subscription, local, loopback and metered backends are
 * produce-only.
 */

import { DevinClient, type DevinFetch } from '../../devin/client.js';
import { roleAllowed, type DispatchRole } from '../../routing/backend-roles.js';
import type { BillingClass } from '../../routing/billing-class.js';
import { adapterById } from './adapters.js';
import type { CodingCliCatalog } from './catalog.js';
import { accountEnv, bestAccount, failoverAccount, type CodingAccount } from './accounts.js';
import { devinCredentials } from './devin-gate.js';
import { cooldownActive, parseCliCooldown, type CliCooldown } from './limits.js';
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
  accountId: string | null;
  poolId: string | null;
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
  /** Precomputed route:any picks. Absent keeps the reserved skip. */
  anyChoices?: Readonly<Record<number, { backend: string; model: string | null; accountId?: string | null; poolId?: string | null }>>;
  accounts?: readonly CodingAccount[];
  /** Process env for Devin's key and org id. The key is not copied into a plan. */
  env?: NodeJS.ProcessEnv;
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
    accountId: null,
    poolId: null,
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
    let backend: string;
    let model: string | null;
    let accountId: string | null = null;
    let poolId: string | null = null;
    let routed = false;
    if (route === 'route:any') {
      if (!input.anyChoices) {
        steps.push(skip(issue, 'route:any waits for the seat-router policy pass', route));
        continue;
      }
      const choice = input.anyChoices[issue.number];
      if (!choice) {
        steps.push(skip(issue, 'seat router found no spendable pool', route));
        continue;
      }
      backend = choice.backend;
      model = choice.model;
      accountId = choice.accountId ?? null;
      poolId = choice.poolId ?? null;
      routed = true;
    } else {
      backend = ROUTE_BACKEND[route];
      model = input.acceptedModels?.[backend] ?? null;
    }
    if (backend === 'cloud') {
      if ((inFlight['cloud-credits'] ?? 0) >= 1) {
        steps.push(skip(issue, 'cloud credit pool is at its daily soft cap', route));
        continue;
      }
      inFlight['cloud-credits'] = (inFlight['cloud-credits'] ?? 0) + 1;
      steps.push({
        number: issue.number,
        title: issue.title,
        action: 'run',
        reason: 'seat router, cloud credit pool. phm cloud remains the launcher',
        route,
        backend,
        billing: null,
        model: null,
        role: 'produce',
        accountId: null,
        poolId: poolId ?? 'cloud-credits',
        worktree: `${input.repo}/.phantom-worktrees/issue-${issue.number}`,
        pullRequest: 'draft',
      });
      continue;
    }
    const record = input.catalog.backends[backend];
    const adapter = adapterById(input.catalog, backend);
    if (!record || !adapter) {
      steps.push(skip(issue, `no adapter for ${backend}`, route));
      continue;
    }
    const devinOn = backend === 'devin' && devinCredentials(input.env ?? {}, input.catalog.backends['devin']?.orgId) !== null;
    if (record.billing === 'metered' && !meteredEnabled && !devinOn) {
      steps.push(skip(issue, 'metered backend is disabled until explicitly enabled', route));
      continue;
    }
    if (!roleAllowed(record.billing, 'produce')) {
      steps.push(skip(issue, 'produce role refused', route));
      continue;
    }
    const cap = input.catalog.concurrency[backend] ?? 1;
    if (input.accounts && !accountId) {
      const room = input.accounts.filter((account) => account.backend === backend && (inFlight[account.id] ?? 0) < cap);
      const account = bestAccount(room, backend, input.nowMs);
      if (!account) {
        steps.push(skip(issue, 'no account has headroom', route));
        continue;
      }
      accountId = account.id;
    }
    const slot = accountId ?? backend;
    if ((inFlight[slot] ?? 0) >= cap) {
      steps.push(skip(issue, `concurrency cap ${cap} is full`, route));
      continue;
    }
    const cooled = (input.cooldowns ?? []).find((row) => row.backend === backend || row.backend === accountId) ?? null;
    if (cooldownActive(cooled, input.nowMs)) {
      steps.push(skip(issue, cooled?.reason ?? 'backend is in cooldown', route));
      continue;
    }
    inFlight[slot] = (inFlight[slot] ?? 0) + 1;
    const modelNote = model ? 'account-verified model' : 'CLI default model (no named model is account-verified)';
    steps.push({
      number: issue.number,
      title: issue.title,
      action: 'run',
      reason: routed ? `seat router, ${modelNote}` : `pinned route, ${modelNote}`,
      route,
      backend,
      billing: record.billing,
      model,
      role: 'produce',
      accountId,
      poolId,
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
    if (step.accountId) lines.push(`  account: ${step.accountId}`);
    if (step.poolId) lines.push(`  pool: ${step.poolId}`);
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

export interface ExecuteOptions {
  accounts?: readonly CodingAccount[];
  nowMs?: number;
  /** Injected transport. Absent means this call does not contact Devin. */
  devinFetch?: DevinFetch;
}

/**
 * Run one planned step. Draft PR only. The runner sees a scrubbed environment
 * with the selected account home. Devin reads DEVIN_API_KEY from that env and
 * posts one session. The key is not a command or a detail string.
 */
export async function executeStep(
  step: WorkerPlanStep,
  issue: IssueJob,
  catalog: CodingCliCatalog,
  runner: CliRunner,
  sourceEnv: NodeJS.ProcessEnv,
  secrets: SecretLookup,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  void secrets;
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
  if (step.backend === 'devin') return runDevin(step, issue, catalog, sourceEnv, options, commands, fail);
  if (step.backend === 'cursor' || step.backend === 'ollama' || !adapter.bin || adapter.execArgs('', '', null).length === 0) {
    return fail(`${step.backend} execution is stubbed on this worker`);
  }
  const accounts = options.accounts ?? [];
  let account = accounts.find((row) => row.id === step.accountId) ?? null;
  let env = accountEnv(sourceEnv, account);
  const branch = `phantom/issue-${step.number}`;
  const worktreeArgs = ['worktree', 'add', '-b', branch, step.worktree, 'HEAD'];
  commands.push(`git ${worktreeArgs.join(' ')}`);
  const worktree: CliResult = await runner.run('git', worktreeArgs, env);
  if (worktree.code !== 0) return fail('git worktree add failed');
  const execArgs = adapter.execArgs(goalText(issue), step.worktree, step.model);
  const render = (bin: string, args: readonly string[]): string => `${bin} ${args.map((arg) => (arg.includes(' ') ? '<goal>' : arg)).join(' ')}`;
  commands.push(render(adapter.bin, execArgs));
  let run = await runner.run(adapter.bin, execArgs, env);
  if (run.code !== 0) {
    const nowMs = options.nowMs ?? Date.now();
    const limited = parseCliCooldown(step.backend, `${run.stdout}\n${run.stderr}`, nowMs);
    const next = limited && account ? failoverAccount(accounts, step.backend, account.id, nowMs) : null;
    if (!next) return fail('adapter exec failed');
    account = next;
    env = accountEnv(sourceEnv, account);
    commands.push(render(adapter.bin, execArgs));
    run = await runner.run(adapter.bin, execArgs, env);
    if (run.code !== 0) return fail('adapter exec failed');
  }
  const prArgs = ['pr', 'create', '--draft', '--title', issue.title, '--body', issue.body || issue.title];
  commands.push(`gh ${prArgs.join(' ')}`);
  if (prArgs.includes('merge') || !prArgs.includes('--draft')) return fail('PR command was not draft-only');
  const pr = await runner.run('gh', prArgs, env);
  if (pr.code !== 0) return fail('draft PR create failed');
  return { number: step.number, ok: true, detail: 'draft PR requested', commands };
}

async function runDevin(
  step: WorkerPlanStep,
  issue: IssueJob,
  catalog: CodingCliCatalog,
  sourceEnv: NodeJS.ProcessEnv,
  options: ExecuteOptions,
  commands: string[],
  fail: (detail: string) => ExecuteResult,
): Promise<ExecuteResult> {
  const creds = devinCredentials(sourceEnv, catalog.backends['devin']?.orgId);
  if (!creds) return fail('Devin adapter is disabled until DEVIN_API_KEY and an org id are both present.');
  if (!options.devinFetch) return fail(`Devin is enabled for ${creds.orgId}. Pass a transport to create the session.`);
  commands.push(`POST /v3/organizations/${creds.orgId}/sessions`);
  try {
    const client = new DevinClient({ apiKey: creds.apiKey, fetch: options.devinFetch, retries: 0, sleep: async () => undefined });
    const session = await client.createSession(creds.orgId, { prompt: goalText(issue), title: issue.title });
    const detail = `Devin session ${session.sessionId}`;
    if (detail.includes(creds.apiKey)) return fail('Devin session was created, and the detail was withheld.');
    return { number: step.number, ok: true, detail, commands };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Devin session create failed';
    return fail(message.includes(creds.apiKey) ? 'Devin session create failed' : message);
  }
}
