/**
 * Unified action-class autonomy registry (RQ-SWE5-ACTION-CLASSES, digest item 7).
 *
 * One catalog of the effect classes an autonomous action may have. Every class
 * carries an explicit gate policy (which control boundary must hold), a blast
 * radius (the widest thing it can touch) and reversibility metadata. dispatchd,
 * the Leader and the publish path all resolve against this single registry —
 * dispatchd and publish.sh through the installed projection
 * `contrib/mac/action-classes.json` + `action_classes.py` (same data; the
 * consistency test keeps the checked-in JSON equal to the projection), the
 * Leader through
 * `actionClassForLeaderKind` inside `classifyLeaderAction`.
 *
 * FAIL CLOSED: `resolveActionClass` never throws. A name the registry does not
 * list resolves to `UNLISTED_ACTION_CLASS` — gate `forbidden`, widest blast
 * radius `unknown`, `irreversible` — so an action whose class is missing,
 * misspelled or unmapped is denied, never silently allowed.
 *
 * Gate names name real control boundaries, not trust levels:
 *   open             — nothing to check; always allowed (read).
 *   confined-launch  — must run inside the job launch confinement (the .sb
 *                      profiles and worktree the launcher applies).
 *   publish-pipeline — the publish.sh gate funnel: git-safe env, secret-shape
 *                      scrub, protected-path denies, the G1 classifier and the
 *                      fork guard.
 *   merge-queue      — a server-enforced protected merge / merge queue on the
 *                      upstream repo (the fleet's standing grant is a further
 *                      gate on that path, not a substitute for it).
 *   release-channel  — the repo's sanctioned release workflow only (release
 *                      autorun / release-please); never the generic publish path.
 *   channel-approval — the comms channel's own reviewed approval path.
 *   operator         — Mason's terminal only; autonomy may never proceed.
 *   forbidden        — no path exists; refused unconditionally.
 *
 * LEAF: no runtime imports — browser-safe, and its Tier-1 import closure is
 * exactly this file (protected-paths.ts roots `src/core/authority/**`).
 */
import type { LeaderActionKind } from '../vision/leader-types.js';

export const ACTION_CLASSES_SCHEMA = 'action-classes.v1';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const ACTION_CLASSES = [
  'read',
  'write-worktree',
  'publish',
  'merge',
  'close',
  'release',
  'external-comms',
  'secrets-touch',
] as const;

export type ActionClass = (typeof ACTION_CLASSES)[number];

export const ACTION_CLASS_GATES = [
  'open',
  'confined-launch',
  'publish-pipeline',
  'merge-queue',
  'release-channel',
  'channel-approval',
  'operator',
  'forbidden',
] as const;

export type ActionClassGate = (typeof ACTION_CLASS_GATES)[number];

/**
 * Widening order: `none` touches nothing durable; `credentials` is the widest
 * named radius (secret material is never recoverable once read); `unknown`
 * sorts last — unlisted classes carry it and compare wider than everything.
 */
export const BLAST_RADIUS_ORDER = [
  'none',
  'worktree',
  'host',
  'fork',
  'upstream',
  'public',
  'credentials',
  'unknown',
] as const;

export type BlastRadius = (typeof BLAST_RADIUS_ORDER)[number];

export const BLAST_RADIUS_RANK: Readonly<Record<BlastRadius, number>> = Object.freeze(
  Object.fromEntries(BLAST_RADIUS_ORDER.map((radius, index) => [radius, index])) as Record<BlastRadius, number>,
);

export const REVERSIBILITIES = ['free', 'revertible', 'costly', 'irreversible'] as const;

export type Reversibility = (typeof REVERSIBILITIES)[number];

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export interface ActionClassEntry {
  readonly listed: true;
  readonly id: ActionClass;
  /** The control boundary that must hold before autonomy may take this class. */
  readonly gate: ActionClassGate;
  readonly blastRadius: BlastRadius;
  readonly reversibility: Reversibility;
  /** One sentence for a reviewer: what the class covers and why the gate is the right one. */
  readonly summary: string;
}

export const ACTION_CLASS_REGISTRY: Readonly<Record<ActionClass, ActionClassEntry>> = Object.freeze({
  read: Object.freeze({
    listed: true,
    id: 'read',
    gate: 'open',
    blastRadius: 'none',
    reversibility: 'free',
    summary:
      'Read-only observation of local state — status, queue, metrics and repo files inside allowed roots; nothing durable changes.',
  }),
  'write-worktree': Object.freeze({
    listed: true,
    id: 'write-worktree',
    gate: 'confined-launch',
    blastRadius: 'worktree',
    reversibility: 'free',
    summary:
      'An agent session writing inside its own git worktree; the launch confinement (.sb profiles, install gate) is the boundary and the reap deletes the tree.',
  }),
  publish: Object.freeze({
    listed: true,
    id: 'publish',
    gate: 'publish-pipeline',
    blastRadius: 'upstream',
    reversibility: 'revertible',
    summary:
      'Commit the worktree delta, push it to the operator fork and open an upstream PR through the publish.sh gate funnel; closing the PR reverts it.',
  }),
  merge: Object.freeze({
    listed: true,
    id: 'merge',
    gate: 'merge-queue',
    blastRadius: 'public',
    reversibility: 'costly',
    summary:
      'Land a reviewed change on the upstream default branch — a server-enforced protected merge or merge queue; undoing it needs a revert PR.',
  }),
  close: Object.freeze({
    listed: true,
    id: 'close',
    gate: 'publish-pipeline',
    blastRadius: 'upstream',
    reversibility: 'free',
    summary: 'Close an upstream PR through the same gated publish path; reopening restores the prior state.',
  }),
  release: Object.freeze({
    listed: true,
    id: 'release',
    gate: 'release-channel',
    blastRadius: 'public',
    reversibility: 'costly',
    summary:
      'Tag, sign and publish a release — only the repo\'s sanctioned release workflow, never the generic publish path; a published artifact can only be superseded, not unpublished.',
  }),
  'external-comms': Object.freeze({
    listed: true,
    id: 'external-comms',
    gate: 'channel-approval',
    blastRadius: 'public',
    reversibility: 'irreversible',
    summary:
      'Send a message on an outside channel (Slack, iMessage, briefs); each channel has its own reviewed approval path and a sent message cannot be unsent.',
  }),
  'secrets-touch': Object.freeze({
    listed: true,
    id: 'secrets-touch',
    gate: 'forbidden',
    blastRadius: 'credentials',
    reversibility: 'irreversible',
    summary:
      'Create, read, rotate or expose secret material — reserved for the operator; autonomy never performs it.',
  }),
});

/** What `resolveActionClass` returns for any name the registry does not list. */
export interface UnlistedActionClass {
  readonly listed: false;
  /** The raw name that failed to resolve. */
  readonly name: string;
  readonly gate: 'forbidden';
  readonly blastRadius: 'unknown';
  readonly reversibility: 'irreversible';
  readonly summary: 'unlisted action class — fail closed';
}

export function isActionClass(name: string): name is ActionClass {
  return (ACTION_CLASSES as readonly string[]).includes(name);
}

/**
 * Look a class name up; unlisted names return the fail-closed unlisted
 * descriptor (never null, never throws).
 */
export function resolveActionClass(name: string): ActionClassEntry | UnlistedActionClass {
  if (isActionClass(name)) return ACTION_CLASS_REGISTRY[name];
  return Object.freeze({
    listed: false,
    name,
    gate: 'forbidden',
    blastRadius: 'unknown',
    reversibility: 'irreversible',
    summary: 'unlisted action class — fail closed',
  });
}

/**
 * What the registry lets autonomy do with a class:
 *   allowed   — a real gate holds and autonomy may proceed through it;
 *   operator  — Mason-only; consuming paths escalate instead of refusing;
 *   forbidden — refused unconditionally (also every unlisted name).
 */
export type ActionClassDisposition = 'allowed' | 'operator' | 'forbidden';

export function actionClassDisposition(name: string): ActionClassDisposition {
  const entry = resolveActionClass(name);
  if (entry.gate === 'forbidden') return 'forbidden';
  if (entry.gate === 'operator') return 'operator';
  return 'allowed';
}

/** True only when the class is listed and its gate lets autonomy proceed at all. */
export function autonomyMayRun(name: string): boolean {
  return actionClassDisposition(name) === 'allowed';
}

// ---------------------------------------------------------------------------
// Dispatcher job classification (dispatchd / publish.sh share this table)
// ---------------------------------------------------------------------------

/**
 * Job-id prefixes → the publish-phase class a dispatched job ends in. First
 * match wins. `RQ-DRAIN-*` and the land-only `RQ-DESK-*` end in an upstream
 * merge; `CLOSE-*` jobs close upstream PRs; every other dispatched job ends in
 * a publish (fork push + PR open). `read`/`write-worktree` are launch-phase
 * classes, not job prefixes: every launch is `write-worktree`, every status
 * read is `read`. `release`, `external-comms` and `secrets-touch` carry no
 * prefix on purpose — nothing dispatched lands in them.
 */
export const JOB_ACTION_CLASS_PREFIXES: ReadonlyArray<readonly [string, ActionClass]> = Object.freeze([
  Object.freeze(['RQ-DRAIN-', 'merge'] as const),
  Object.freeze(['RQ-DESK-', 'merge'] as const),
  Object.freeze(['RQ-CLOSE-', 'close'] as const),
  Object.freeze(['CLOSE-', 'close'] as const),
]);

export const DEFAULT_JOB_ACTION_CLASS: ActionClass = 'publish';

/** The publish-phase action class for one dispatched job id. Always listed. */
export function actionClassForJobId(jobId: string): ActionClass {
  for (const [prefix, cls] of JOB_ACTION_CLASS_PREFIXES) {
    if (jobId.startsWith(prefix)) return cls;
  }
  return DEFAULT_JOB_ACTION_CLASS;
}

/**
 * Gates the generic dispatcher publish path (reap-one.sh → publish.sh) may
 * execute: the publish funnel itself and a server-enforced merge. Anything
 * else — release-channel, channel-approval, operator, forbidden — a dispatcher
 * publish must hold.
 */
export const PUBLISHABLE_GATES: readonly ActionClassGate[] = Object.freeze(['publish-pipeline', 'merge-queue']);

/** True when a dispatched job's publish-phase class may run through publish.sh. */
export function mayDispatchPublish(name: string): boolean {
  const entry = resolveActionClass(name);
  return entry.listed === true && (PUBLISHABLE_GATES as readonly ActionClassGate[]).includes(entry.gate);
}

// ---------------------------------------------------------------------------
// Leader kinds
// ---------------------------------------------------------------------------

/**
 * Leader action kinds whose effect lands in a registry class. `work.dispatch`
 * and the founder-mode launches run agents that write in worktrees; `pr.close`
 * closes an upstream PR. Kinds that only reshape leader-owned local state
 * (goals, standards, budgets, directives) have no external-effect class and
 * map to null — their A/B/C authority stays the Leader's own grant axis.
 */
export const LEADER_KIND_ACTION_CLASS: Readonly<Partial<Record<LeaderActionKind, ActionClass>>> = Object.freeze({
  'work.dispatch': 'write-worktree',
  'cloud.launch': 'write-worktree',
  'devin.launch': 'write-worktree',
  'pr.close': 'close',
});

/** The external-effect class a leader kind lands in; null when it has none. */
export function actionClassForLeaderKind(kind: LeaderActionKind): ActionClass | null {
  return LEADER_KIND_ACTION_CLASS[kind] ?? null;
}

// ---------------------------------------------------------------------------
// Projection — the JSON the installed dispatcher helpers consume
// ---------------------------------------------------------------------------

export interface ActionClassesProjection {
  schema: typeof ACTION_CLASSES_SCHEMA;
  /** Every gate value, so a consumer can refuse a registry naming one it does not know. */
  gates: readonly ActionClassGate[];
  blastRadii: readonly BlastRadius[];
  reversibilities: readonly Reversibility[];
  classes: Readonly<Record<ActionClass, Omit<ActionClassEntry, 'listed' | 'id'>>>;
  jobClassMap: {
    prefixes: ReadonlyArray<readonly [string, ActionClass]>;
    default: ActionClass;
  };
  publishableGates: readonly ActionClassGate[];
  /** Which leader kinds carry an external-effect class (kind → class). */
  leaderKinds: Readonly<Partial<Record<LeaderActionKind, ActionClass>>>;
}

/**
 * Serialize the registry as the JSON artifact `contrib/mac/action-classes.json`
 * carries. Pure and deterministic — the consistency test asserts the checked-in
 * file equals this projection exactly.
 */
export function actionClassesProjection(): ActionClassesProjection {
  const classes = {} as Record<ActionClass, Omit<ActionClassEntry, 'listed' | 'id'>>;
  for (const id of ACTION_CLASSES) {
    const entry = ACTION_CLASS_REGISTRY[id];
    classes[id] = Object.freeze({
      gate: entry.gate,
      blastRadius: entry.blastRadius,
      reversibility: entry.reversibility,
      summary: entry.summary,
    });
  }
  return {
    schema: ACTION_CLASSES_SCHEMA,
    gates: ACTION_CLASS_GATES,
    blastRadii: BLAST_RADIUS_ORDER,
    reversibilities: REVERSIBILITIES,
    classes,
    jobClassMap: { prefixes: JOB_ACTION_CLASS_PREFIXES, default: DEFAULT_JOB_ACTION_CLASS },
    publishableGates: PUBLISHABLE_GATES,
    leaderKinds: LEADER_KIND_ACTION_CLASS,
  };
}
