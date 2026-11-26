/** `phm node contributor [join|status|leave] [--json]`: planned public compute enrollment. Thin: core/drive/nodes/contributor.ts holds the plan. */
import { CONTRIBUTOR_SPEC, CONTRIBUTOR_VERBS, contributorPlan, contributorVerbAnswer, type ContributorVerb } from '../core/drive/nodes/contributor.js';

export const CONTRIBUTOR_USAGE = `Usage: phm node contributor [join|status|leave] [--json]

Planned open contributor fleet: outside machines enroll a short-lived, revocable
grant (node key, owner scope, caps, job limit, max data class) and pull
public-only jobs over outbound authenticated connections. No public broker is
deployed yet, so the surface is a plan, not a service:

  (no verb)     Print the enrollment plan: broker status, tiers, data boundary,
                custody rules, the proposed verbs and the paths that work today.
  join          Cannot enroll: the broker is not deployed (exit 1).
  status        Reports enrolled:false while no broker exists (exit 0).
  leave         Reports left:false: there is no contributor session to revoke (exit 0).

What works today instead: code via fork pull request (docs/CONTRIBUTE-WITH-AN-AGENT.md),
this machine as a local node (docs/add-a-computer.md), the team pool by invitation
(docs/NODES.md). Spec: ${CONTRIBUTOR_SPEC}`;

const VERB_SET = new Set<string>(CONTRIBUTOR_VERBS);

function usageError(json: boolean, message: string): number {
  if (json) console.log(JSON.stringify({ schemaVersion: 1, command: 'contributor',
    error: { code: 'usage', message, fix: 'Run: phm node contributor --help' } }));
  else console.error(`${message}\n${CONTRIBUTOR_USAGE}`);
  return 2;
}

function planText(): string {
  const plan = contributorPlan();
  return [
    'Contributor fleet — planned; no public broker is deployed (executable:false).',
    '',
    'Enrollment: a short-lived, revocable grant bound to a node key, owner scope,',
    'capabilities, job limit and maximum data class. The server derives eligibility; a worker never supplies',
    'its own owner or caps. Workers connect outbound only; the private node store and trusted',
    'SSH endpoints are never exposed.',
    '',
    'Data boundary: Public-only jobs; unclassified work fails closed. No private repos,',
    'credentials, merge ability or held-out corpus reaches a community node.',
    '',
    'Custody: bring your own compute (local model, permitted subscription capacity or your own',
    'metered credits) with explicit limits and a quota circuit breaker. Sign in locally; jobs',
    'carry secret NAMES, never values; community nodes get no merge credential.',
    '',
    'Tiers:',
    ...plan.tiers.map(t => `  ${t.name}: ${t.contribution} Boundary: ${t.boundary}`),
    '',
    'Verbs (all planned, none deployed):',
    ...CONTRIBUTOR_VERBS.map(v => `  ${v}: ${plan.verbs[v]}`),
    '',
    'Works today:',
    ...plan.today.map(p => `  ${p.path}: ${p.does}`),
    '',
    'When the broker ships:',
    ...plan.steps.map((s, i) => `  ${i + 1}. ${s}`),
  ].join('\n');
}

const JOIN_FIX = 'Contribute code via a fork pull request (docs/CONTRIBUTE-WITH-AN-AGENT.md), '
  + 'run this machine as a local node (docs/add-a-computer.md), or join the team pool by invitation (docs/NODES.md). '
  + 'The full plan: phm node contributor --json';

export function cmdNodeContributor(args: string[]): number {
  // Help never acts; cmdNode's dispatcher-level --help normally answers first.
  if (args.includes('--help') || args.includes('-h')) { console.log(CONTRIBUTOR_USAGE); return 0; }
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  const verb = rest.length === 1 ? rest[0]! : undefined;
  const bad = args.filter(a => a === '--json').length > 1 || rest.length > 1 ||
    rest.some(a => a.startsWith('-')) || (verb !== undefined && !VERB_SET.has(verb));
  if (bad) return usageError(json, `Invalid contributor arguments${verb !== undefined && !VERB_SET.has(verb) ? `: unknown verb '${verb}'` : ''}.`);
  if (verb === undefined) {
    if (json) console.log(JSON.stringify({ command: 'contributor', ...contributorPlan() }));
    else console.log(planText());
    return 0;
  }
  const v = verb as ContributorVerb;
  const answer = contributorVerbAnswer(v);
  if (v === 'join') {
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command: 'contributor', ...answer,
      error: { code: 'unavailable', message: 'The public contributor broker is not deployed; join cannot enroll a node.', fix: JOIN_FIX } }));
    else console.error(`Contributor enrollment is not available: the public broker is not deployed, so this command cannot enroll a node.\nFix: ${JOIN_FIX}`);
    return 1;
  }
  if (json) console.log(JSON.stringify({ schemaVersion: 1, command: 'contributor', ...answer }));
  else if (v === 'status') console.log('No contributor enrollment: the public broker is not deployed (enrolled:false). `phm node contributor` prints the plan.');
  else console.log('Nothing to revoke: no contributor session exists and the public broker is not deployed.');
  return 0;
}
