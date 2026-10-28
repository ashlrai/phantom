/** Paired, held-out evaluation before an authorized learning change is applied. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { learnDir } from '../config.js';
import { scrubSecrets } from '../util/scrub.js';

export interface EvalCandidate<Config> {
  id: string;
  kind: 'prior' | 'prompt' | 'playbook';
  /** Revision the candidate was derived from, checked atomically by apply. */
  baseRevision: string;
  value: Config;
}

export interface EvalTask<Input> {
  id: string;
  input: Input;
}

export interface EvalPair {
  taskId: string;
  baseline: number;
  candidate: number;
}

export interface EvalDecision {
  candidateId: string;
  kind: EvalCandidate<unknown>['kind'];
  status: 'rejected' | 'promoted';
  reason: 'missing-data' | 'invalid-data' | 'evaluation-failed' | 'regression'
    | 'stale-baseline' | 'apply-failed' | 'no-regression';
  pairs: EvalPair[];
}

export interface EvalGateOptions<Config, Input> {
  candidate: EvalCandidate<Config>;
  baseline: Config;
  tasks: readonly EvalTask<Input>[] | null | undefined;
  /** Trusted, side-effect-free replay scorer: finite quality in [0, 1].
   * Return null for unavailable evidence. Use the same scorer for both arms.
   * Inputs must be structured-cloneable. Each invocation gets a fresh copy.
   */
  replay: (task: EvalTask<Input>, value: Config) => Promise<number | null> | number | null;
  /** Existing authority checks still apply. Atomically compare baseRevision
   * against the active revision and persist value. Return false on conflict.
   * Throw only when no change was applied. The gate grants no authority.
   */
  apply: (candidate: EvalCandidate<Config>) => Promise<boolean> | boolean;
}

function validScore(score: unknown): score is number {
  return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Metadata only: never persist candidate contents, task inputs or errors. */
function record(decision: Omit<EvalDecision, 'status'> & { status: EvalDecision['status'] | 'evaluated' }): void {
  const dir = learnDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, 'eval-gate.jsonl'), JSON.stringify({
    at: new Date().toISOString(),
    ...decision,
    candidateId: scrubSecrets(decision.candidateId).slice(0, 200),
    pairs: decision.pairs.map(pair => ({ ...pair, taskId: scrubSecrets(pair.taskId).slice(0, 200) })),
  }) + '\n', { mode: 0o600, flush: true });
}

/**
 * Evaluate every held-out task in both arms before calling apply exactly once.
 * A gain cannot hide another task's regression. Ties qualify; missing evidence
 * never does. Rejections are durably appended to learn/eval-gate.jsonl.
 * Audit I/O errors propagate, never silently discarding a rejection.
 * This helper does not activate harnesses or bypass their adoption gates.
 */
export async function promoteWithEval<Config, Input>(
  options: EvalGateOptions<Config, Input>,
): Promise<EvalDecision> {
  const pairs: EvalPair[] = [];
  const candidateId = options.candidate.id;
  const kind = options.candidate.kind;
  const finish = (status: EvalDecision['status'], reason: EvalDecision['reason']): EvalDecision => {
    const decision: EvalDecision = {
      candidateId,
      kind,
      status, reason, pairs,
    };
    record(decision);
    return decision;
  };
  if (!options.tasks?.length || options.baseline == null || options.candidate.value == null) {
    return finish('rejected', 'missing-data');
  }
  if (!nonempty(options.candidate.id) || !nonempty(options.candidate.baseRevision)
    || !['prior', 'prompt', 'playbook'].includes(options.candidate.kind)
    || options.tasks.some(task => !task || !nonempty(task.id))
    || new Set(options.tasks.map(task => task.id)).size !== options.tasks.length) {
    return finish('rejected', 'invalid-data');
  }

  // Snapshot before awaiting: callers and scorers cannot change what we apply.
  let snapshot: Pick<EvalGateOptions<Config, Input>, 'candidate' | 'baseline' | 'tasks'>;
  try {
    snapshot = structuredClone({ candidate: options.candidate, baseline: options.baseline, tasks: options.tasks });
  } catch {
    return finish('rejected', 'invalid-data');
  }
  for (const task of snapshot.tasks!) {
    let baseline: number | null;
    let candidate: number | null;
    try {
      baseline = await options.replay(structuredClone(task), structuredClone(snapshot.baseline));
      candidate = await options.replay(structuredClone(task), structuredClone(snapshot.candidate.value));
    } catch {
      return finish('rejected', 'evaluation-failed');
    }
    if (baseline == null || candidate == null) return finish('rejected', 'missing-data');
    if (!validScore(baseline) || !validScore(candidate)) return finish('rejected', 'invalid-data');
    pairs.push({ taskId: task.id, baseline, candidate });
  }
  if (pairs.some(pair => pair.candidate < pair.baseline)) return finish('rejected', 'regression');

  // Require a writable audit trail before any mutation. A crash after this
  // record leaves an evaluated attempt, never a false promotion receipt.
  record({ candidateId, kind, status: 'evaluated', reason: 'no-regression', pairs });
  let applied: boolean;
  try {
    applied = await options.apply(snapshot.candidate);
  } catch {
    return finish('rejected', 'apply-failed');
  }
  return applied === true ? finish('promoted', 'no-regression') : finish('rejected', 'stale-baseline');
}
