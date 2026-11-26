/**
 * Contributor fleet surface (docs/strategy/RECURSIVE-SELF-IMPROVEMENT-AND-OPEN-FLEET-2026-11.md,
 * "Open contributor fleet: public work, local custody").
 *
 * Planning only: no public broker, enrollment service or shared queue exists
 * yet, so every verb answers executable:false — `join` cannot enroll, `status`
 * reports enrolled:false and `leave` has nothing to revoke. The plan names the
 * enrollment contract the broker will enforce and the contribution paths that
 * work today, so an outside machine's agent gets a truthful answer instead of
 * "unknown command". Pure: no I/O, no credentials, no network, nothing throws.
 */

/** Repo-relative spec the plan points at; kept as a path so docs moves stay visible. */
export const CONTRIBUTOR_SPEC = 'docs/strategy/RECURSIVE-SELF-IMPROVEMENT-AND-OPEN-FLEET-2026-11.md';

export const CONTRIBUTOR_VERBS = ['join', 'status', 'leave'] as const;
export type ContributorVerb = (typeof CONTRIBUTOR_VERBS)[number];

export interface ContributorTier {
  name: 'guest' | 'verified-community' | 'enrolled-team';
  contribution: string;
  boundary: string;
}

export interface ContributorPath {
  path: string;
  does: string;
}

export interface ContributorPlan {
  schemaVersion: 1;
  dryRun: true;
  executable: false;
  broker: {
    status: 'not-deployed';
    spec: string;
    enrollment: string;
    transport: string;
    receipt: string;
  };
  dataBoundary: string;
  custody: string;
  tiers: ContributorTier[];
  verbs: Record<ContributorVerb, string>;
  today: ContributorPath[];
  steps: string[];
}

/** The enrollment contract and boundaries, verbatim in spirit from the spec. */
export function contributorPlan(): ContributorPlan {
  return {
    schemaVersion: 1,
    dryRun: true,
    executable: false,
    broker: {
      status: 'not-deployed',
      spec: CONTRIBUTOR_SPEC,
      enrollment: 'A short-lived, revocable grant bound to a contributor principal, node key, owner scope, capabilities, job limit and maximum data class. The server derives eligibility from grants; a worker never supplies its own owner or capability strings.',
      transport: 'Workers make outbound authenticated connections only; the private node store and trusted SSH endpoints are never exposed to the public path.',
      receipt: 'fleet.contribution.v1: a signed receipt after trusted acceptance, once per job and fence — offered capacity is reported separately from verified work.',
    },
    dataBoundary: 'Public-only jobs: the whole job — prompt, commit, dependencies, artifact destinations, cache and provider eligibility — is classified, and unclassified work fails closed on the public path. No private repositories, credentials, merge ability or protected held-out corpus reaches a community node.',
    custody: 'Contributors bring their own compute: a local model, permitted subscription capacity or their own metered credits, with explicit limits, pause/leave and a quota circuit breaker. Provider sign-in stays on the contributor\'s own machine; jobs carry secret NAMES, never values, and community nodes get no merge credential.',
    tiers: [
      { name: 'guest', contribution: 'Local smoke job or bounded public fixture/replay.',
        boundary: 'Synthetic or explicitly public data only; no publication or privileged judging.' },
      { name: 'verified-community', contribution: 'Public builds, benchmarks and candidate patches after reproducible accepted work.',
        boundary: 'Explicitly public only, still untrusted output; no private repos, shared shells, deploy keys, merge ability or protected held-out corpus.' },
      { name: 'enrolled-team', contribution: 'Separately enrolled team work and independent verification.',
        boundary: "Only that owner's permitted data classes; confidential and restricted stay on authorized owner infrastructure, never the public broker." },
    ],
    verbs: {
      join: 'Enroll this machine\'s node key into a public-only scope. Not deployed: exits 1 today.',
      status: 'Show this principal\'s own scope, limits and liveness. Not deployed: reports enrolled:false.',
      leave: 'Retire the local session and drop its leases. Not deployed: reports left:false.',
    },
    today: [
      { path: 'docs/CONTRIBUTE-WITH-AN-AGENT.md',
        does: 'Contribute code and intelligence: fork, one focused branch, local checks once, pull request through Merge Gate.' },
      { path: 'docs/add-a-computer.md',
        does: 'Run this machine as a node in a local owner scope it creates itself; single-host, no shared queue.' },
      { path: 'docs/NODES.md',
        does: 'Multi-Mac compute pool for enrolled team machines over trusted SSH aliases; not open enrollment.' },
    ],
    steps: [
      'When the broker ships: verify the published, version-pinned package and coordinator.',
      'Enroll a node key into a public-only scope: phm node contributor join --json.',
      'Choose local compute or an allowed provider with a hard local budget; sign in locally and never share auth.',
      'Run one signed smoke fixture, then check liveness and the fleet.contribution.v1 verification receipt.',
      'phm node contributor leave --json revokes the session; the output shows what stops and what receipt data remains.',
    ],
  };
}

/** Per-verb answer while the broker is absent. `join` is the only mutating verb, so it is the only refusal. */
export function contributorVerbAnswer(verb: ContributorVerb): Record<string, unknown> {
  switch (verb) {
    case 'join':
      return { verb, registered: false, broker: 'not-deployed', plan: 'phm node contributor --json' };
    case 'status':
      return { verb, enrolled: false, broker: 'not-deployed' };
    case 'leave':
      return { verb, left: false, reason: 'no-contributor-session', broker: 'not-deployed' };
  }
}
