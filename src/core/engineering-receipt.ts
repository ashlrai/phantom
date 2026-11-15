import { scrubSecrets } from './util/scrub-secrets.js';

/**
 * Engineering receipt: separates what the tool log proves (Evidence) from what
 * the model said (Claims). Evidence is derived ONLY from recorded tool events;
 * model text is never parsed for facts, only compared against evidence.
 * Behind PHANTOM_RECEIPTS (default off).
 */

export type ReceiptEvent =
  | { type: 'task'; text: string }
  | { type: 'edit'; path: string }
  | { type: 'command'; command: string; exitCode: number | null; output?: string };

export type CheckKind = 'typecheck' | 'test' | 'integration' | 'build';
export type Scope = 'local' | 'ci' | 'staging' | 'prod';
export interface SuiteCounts { command: string; passed: number; failed: number; skipped: number; exitCode: number | null; afterLastEdit: boolean }
export interface Claim { text: string; kind: ClaimKind; status: 'supported' | 'UNVERIFIED'; reason: string | null }
export type ClaimKind = 'tests' | 'typecheck' | 'build' | 'deploy' | 'commit' | 'integration' | 'other';

export interface Receipt {
  task: string | null;
  evidence: {
    commitSha: string | null;
    typecheck: 'pass' | 'fail' | 'not run';
    suites: SuiteCounts[];
    integration: SuiteCounts[];
    build: 'pass' | 'fail' | 'not run';
    deploy: { attempted: boolean; target: string | null; ok: boolean | null };
    verificationScope: Scope;
    edits: number;
    /** True when an edit happened after the last typecheck/test/build command. */
    noCheckAfterEdit: boolean;
  };
  claims: Claim[];
}

export const receiptsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.PHANTOM_RECEIPTS === '1';

const TYPECHECK = /\b(tsc|tsgo|typecheck|check:types|mypy|pyright|cargo check|go build|go vet)\b/;
const INTEGRATION = /\b(integration|e2e|playwright|cypress)\b/;
const TEST = /\b(vitest|jest|mocha|pytest|cargo test|go test|test(?::\w+)?|bun test|node --test)\b/;
const BUILD = /\b(npm run build|pnpm (run )?build|yarn build|bun run build|cargo build|next build|vite build)\b/;
const DEPLOY = /\b(vercel(?: deploy)?|fly deploy|flyctl deploy|netlify deploy|wrangler (?:deploy|publish)|kubectl apply|helm (?:upgrade|install)|terraform apply|git push \S+ (?:heroku|production|prod))\b/;
const CI = /\bgh (?:run (?:watch|view)|pr checks)\b/;
const SMOKE = /\b(curl|smoke|healthcheck|health-check)\b/;

function counts(output: string): { passed: number; failed: number; skipped: number } | null {
  // vitest/jest summary lines, e.g. "Tests  1 failed | 10 passed | 2 skipped (13)" / "Tests: 1 failed, 5 passed, 6 total"
  const summary = /^\s*Tests:?\s+.*$/m.exec(output)?.[0];
  if (summary) return { passed: Number(/(\d+) passed/.exec(summary)?.[1] ?? 0), failed: Number(/(\d+) failed/.exec(summary)?.[1] ?? 0), skipped: Number(/(\d+) (?:skipped|todo)/.exec(summary)?.[1] ?? 0) };
  // cargo: "test result: ok. 5 passed; 0 failed; 1 ignored;"
  const cargo = [...output.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (cargo.length) return cargo.reduce((a, m) => ({ passed: a.passed + +m[1]!, failed: a.failed + +m[2]!, skipped: a.skipped + +m[3]! }), { passed: 0, failed: 0, skipped: 0 });
  // pytest: "5 passed, 1 failed, 2 skipped in 0.1s"
  const py = /(?:^|\n)=*\s*((?:\d+ (?:passed|failed|skipped|error|errors|xfailed|deselected)(?:, )?)+) in [\d.]+s/.exec(output)?.[1];
  if (py) return { passed: Number(/(\d+) passed/.exec(py)?.[1] ?? 0), failed: Number(/(\d+) failed/.exec(py)?.[1] ?? 0) + Number(/(\d+) errors?/.exec(py)?.[1] ?? 0), skipped: Number(/(\d+) skipped/.exec(py)?.[1] ?? 0) };
  return null;
}

function deployTarget(command: string): string {
  if (/--prod\b|\bproduction\b|\bprod\b/.test(command)) return 'prod';
  if (/\bstaging\b|\bstage\b/.test(command)) return 'staging';
  if (/\bpreview\b/.test(command)) return 'preview';
  return 'unspecified';
}

export function classifyCommand(command: string): CheckKind | 'deploy' | 'commit' | 'ci' | 'smoke' | null {
  if (/^\s*git commit\b/.test(command)) return 'commit';
  if (DEPLOY.test(command) && !/\b(vercel (?:ls|list|inspect|logs|env|whoami))\b/.test(command)) return 'deploy';
  if (CI.test(command)) return 'ci';
  if (INTEGRATION.test(command)) return 'integration';
  if (TYPECHECK.test(command)) return 'typecheck';
  if (BUILD.test(command)) return 'build';
  if (TEST.test(command)) return 'test';
  if (SMOKE.test(command)) return 'smoke';
  return null;
}

const claimKind = (text: string): ClaimKind => {
  if (/\b(deploy|deployed|shipped|released|live in)\b/i.test(text)) return 'deploy';
  if (/\b(integration|e2e|end-to-end)\b/i.test(text)) return 'integration';
  if (/\b(tests?|specs?|suite)\b.*\b(pass|passing|passed|green|succeed\w*)\b|\b(all )?(pass|green)\b/i.test(text)) return 'tests';
  if (/\b(typecheck|type-check|tsc|types? (?:check|are))\b/i.test(text)) return 'typecheck';
  if (/\bbuild\b.*\b(pass|succeed\w*|clean|works?|green)\b/i.test(text)) return 'build';
  if (/\b(committed|commit)\b/i.test(text)) return 'commit';
  return 'other';
};

export function buildReceipt(events: readonly ReceiptEvent[], opts: { task?: string; claims?: readonly string[] } = {}): Receipt {
  let lastEdit = -1;
  let lastCheck = -1;
  let edits = 0;
  let task: string | null = opts.task ?? null;
  events.forEach((e, i) => {
    if (e.type === 'task') task ??= e.text;
    else if (e.type === 'edit') { lastEdit = i; edits++; }
    else {
      const kind = classifyCommand(e.command);
      if (kind === 'typecheck' || kind === 'test' || kind === 'integration' || kind === 'build') lastCheck = i;
    }
  });

  const suites: SuiteCounts[] = [];
  const integration: SuiteCounts[] = [];
  let typecheck: 'pass' | 'fail' | 'not run' = 'not run';
  let build: 'pass' | 'fail' | 'not run' = 'not run';
  let commitSha: string | null = null;
  let deploy: Receipt['evidence']['deploy'] = { attempted: false, target: null, ok: null };
  let scope: Scope = 'local';

  events.forEach((e, i) => {
    if (e.type !== 'command') return;
    const kind = classifyCommand(e.command);
    const ok = e.exitCode === 0;
    const afterLastEdit = i > lastEdit;
    if (kind === 'commit' && ok) commitSha = /\[[^\]\n]+ ([0-9a-f]{7,40})\]/.exec(e.output ?? '')?.[1] ?? commitSha;
    else if (kind === 'typecheck') { typecheck = ok ? 'pass' : 'fail'; }
    else if (kind === 'build') { build = ok ? 'pass' : 'fail'; }
    else if (kind === 'test' || kind === 'integration') {
      const c = counts(e.output ?? '') ?? { passed: 0, failed: ok ? 0 : 1, skipped: 0 };
      (kind === 'test' ? suites : integration).push({ command: e.command, ...c, exitCode: e.exitCode, afterLastEdit });
    } else if (kind === 'deploy') {
      deploy = { attempted: true, target: deployTarget(e.command), ok };
    } else if (kind === 'ci' && ok) scope = 'ci';
    else if (kind === 'smoke' && ok && deploy.attempted && (deploy.target === 'staging' || deploy.target === 'prod')) scope = deploy.target;
  });

  const noCheckAfterEdit = lastEdit > lastCheck;
  // Only runs after the last edit count; earlier runs (e.g. a failure since fixed) are history.
  const fresh = (list: SuiteCounts[]) => list.filter((s) => s.afterLastEdit);
  const allOk = (list: SuiteCounts[]) => fresh(list).length > 0 && fresh(list).every((s) => s.exitCode === 0 && s.failed === 0);
  const checkedFresh = (kind: CheckKind) => events.some((e, i) => e.type === 'command' && i > lastEdit && classifyCommand(e.command) === kind && e.exitCode === 0);

  const claims = (opts.claims ?? []).map((text): Claim => {
    const kind = claimKind(text);
    let reason: string | null = null;
    if (kind === 'tests') reason = suites.length === 0 ? 'no test event recorded' : !allOk(suites) ? (fresh(suites).length ? 'recorded test run failed' : 'edit after last test run') : null;
    else if (kind === 'integration') reason = integration.length === 0 ? 'no integration test event recorded' : !allOk(integration) ? 'integration run failed or predates last edit' : null;
    else if (kind === 'typecheck') reason = typecheck === 'not run' ? 'no typecheck event recorded' : !checkedFresh('typecheck') ? 'typecheck failed or predates last edit' : null;
    else if (kind === 'build') reason = build === 'not run' ? 'no build event recorded' : !checkedFresh('build') ? 'build failed or predates last edit' : null;
    else if (kind === 'deploy') reason = !deploy.attempted ? 'no deploy event recorded' : deploy.ok ? null : 'deploy command failed';
    else if (kind === 'commit') reason = commitSha ? null : 'no commit event recorded';
    else reason = 'no evidence source for this claim';
    return { text, kind, status: reason ? 'UNVERIFIED' : 'supported', reason };
  });

  const receipt: Receipt = { task, evidence: { commitSha, typecheck, suites, integration, build, deploy, verificationScope: scope, edits, noCheckAfterEdit }, claims };
  return scrubReceipt(receipt);
}

/** Every string in the receipt passes through the secret scrubber; command lines are also length-capped. */
function scrubReceipt<T>(value: T): T {
  if (typeof value === 'string') return scrubSecrets(value).slice(0, 300) as T;
  if (Array.isArray(value)) return value.map(scrubReceipt) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubReceipt(v)])) as T;
  return value;
}

export function parseEvents(jsonl: string): ReceiptEvent[] {
  const out: ReceiptEvent[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: unknown;
    try { e = JSON.parse(line); } catch { continue; }
    const r = e as Record<string, unknown>;
    if (r?.type === 'task' && typeof r.text === 'string') out.push({ type: 'task', text: r.text });
    else if (r?.type === 'edit' && typeof r.path === 'string') out.push({ type: 'edit', path: r.path });
    else if (r?.type === 'command' && typeof r.command === 'string') out.push({ type: 'command', command: r.command, exitCode: typeof r.exitCode === 'number' ? r.exitCode : null, output: typeof r.output === 'string' ? r.output : undefined });
  }
  return out;
}

const tally = (s: SuiteCounts) => `${s.passed} passed / ${s.failed} failed / ${s.skipped} skipped${s.afterLastEdit ? '' : ' (before last edit)'}`;

export function renderReceipt(r: Receipt): string {
  const e = r.evidence;
  const lines = [
    '# Engineering receipt',
    `Task: ${r.task ?? 'not recorded'}`,
    '',
    '## Evidence (from tool events)',
    `Commit: ${e.commitSha ?? 'none recorded'}`,
    `Typecheck: ${e.typecheck}`,
    `Build: ${e.build}`,
    ...(e.suites.length ? e.suites.map((s) => `Tests [${s.command}]: ${tally(s)}`) : ['Tests: not run']),
    ...(e.integration.length ? e.integration.map((s) => `Integration [${s.command}]: ${tally(s)}`) : ['Integration: not run']),
    `Deploy: ${e.deploy.attempted ? `attempted → ${e.deploy.target} (${e.deploy.ok ? 'ok' : 'failed'})` : 'not attempted'}`,
    `Verification scope: ${e.verificationScope}`,
    `Edits: ${e.edits}`,
    ...(e.noCheckAfterEdit ? ['FLAG no-check-after-edit: last edit has no later test/typecheck/build'] : []),
    '',
    '## Claims (model statements)',
    ...(r.claims.length ? r.claims.map((c) => `- ${c.status === 'UNVERIFIED' ? `UNVERIFIED (${c.reason})` : 'supported'}: ${c.text}`) : ['(none)']),
  ];
  return lines.join('\n');
}
