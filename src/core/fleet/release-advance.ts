/**
 * Idempotent advance of an eligible immutable release candidate into the
 * existing attestation lane (RQ-PHX-RELEASEADVANCE05SRL1). All gate, tree and
 * artifact evidence comes from planReleaseCandidate; on --apply the plan is
 * refreshed immediately before the mutation and the dispatch is sent only
 * while every condition still holds. The argv is built from typed fields —
 * the planner's human-readable NextAction.command text is never executed and
 * no shell is involved. `submitted` means gh accepted the workflow_dispatch;
 * a release is never claimed published. Re-running observes a pending or
 * successful attest on the same exact candidate and does not submit again.
 * There is no cross-process lock: an actor dispatching between this
 * command's final read and its POST can still double-submit, and a queued
 * attest more than MAX_REPORTED deep in the candidate's run list is outside
 * the planner's bounded view — the workflow's own guards are the backstop.
 */

import { stripVTControlCharacters } from 'node:util';
import { tmpdir } from 'node:os';
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';
import { scrubSecrets } from '../util/scrub.js';
import { planReleaseCandidate, type ReleaseCandidatePlan } from './release-candidate-plan.js';

const TIMEOUT_MS = 30_000;
const DISPATCH_MAX_BYTES = 256 * 1024;
const MAX_FIELD = 200;
const ATTEST_WORKFLOW = 'attest-ci-build.yml';

export type ReleaseAdvanceOutcome = 'planned' | 'submitted' | 'no-op' | 'blocked' | 'unavailable' | 'refused';

export interface AttestInputs {
  ci_run_id: number;
  ci_run_attempt: number;
  candidate_sha: string;
  build_artifact_id: number;
}

export interface ReleaseAdvanceReport {
  version: 1;
  repo: string;
  tag: string;
  apply: boolean;
  outcome: ReleaseAdvanceOutcome;
  reason: string;
  /** Plan outcome the decision ran on; under --apply this is the refreshed plan. */
  planOutcome: ReleaseCandidatePlan['outcome'];
  candidate: { sha: string | null; tree: string | null };
  master: { branch: string | null; sha: string | null; tree: string | null };
  masterMoved: boolean | null;
  treeMatch: boolean | null;
  gateRun: { id: number; attempt: number | null; conclusion: string | null } | null;
  producerArtifact: { id: number; name: string; expired: boolean } | null;
  /** Successful attest run already bound to this exact candidate, if any. */
  attestedRun: { id: number; attempt: number | null } | null;
  /** Attest run still in flight on this exact candidate, if any. */
  inFlightRun: { id: number; attempt: number | null; status: string } | null;
  release: { state: ReleaseCandidatePlan['release']['state']; id: number | null };
  blockers: ReleaseCandidatePlan['blockers'];
  /** attest-ci-build.yml inputs — proposed on a dry run, submitted under --apply. */
  dispatch: {
    ref: string | null;
    inputs: AttestInputs | null;
    invoked: boolean;
    accepted: boolean;
    detail: string | null;
  };
  truncated: boolean;
}

type Decision =
  | { kind: 'send'; ref: string; inputs: AttestInputs }
  | { kind: 'skip'; outcome: 'no-op' | 'blocked' | 'unavailable'; reason: string };

/** Terminal candidate facts outrank blockers; every skip still zero dispatches. */
function decide(plan: ReleaseCandidatePlan): Decision {
  const attested = plan.attestOnCandidate.find(r => r.conclusion === 'success');
  const inFlight = plan.attestOnCandidate.find(r => r.status !== 'completed');
  if (plan.release.state === 'published') return { kind: 'skip', outcome: 'no-op', reason: 'already_published' };
  if (attested) return { kind: 'skip', outcome: 'no-op', reason: 'already_attested' };
  if (inFlight) return { kind: 'skip', outcome: 'no-op', reason: 'attest_in_flight' };
  if (plan.truncated) return { kind: 'skip', outcome: 'unavailable', reason: 'evidence_truncated' };
  if (plan.blockers.length) return { kind: 'skip', outcome: 'blocked', reason: `blocker:${plan.blockers[0]!.id}` };
  if (plan.outcome !== 'ready') return { kind: 'skip', outcome: 'unavailable', reason: `plan_${plan.outcome}` };
  const candidate = plan.candidate.sha;
  const artifact = plan.producerArtifact;
  if (candidate === null || plan.candidate.tree === null || plan.treeMatch !== true) {
    return { kind: 'skip', outcome: 'unavailable', reason: 'tree_bind_unknown' };
  }
  const gate = plan.gateRun;
  if (gate === null || gate.conclusion !== 'success' || gate.attempt === null || gate.attempt < 1) {
    return { kind: 'skip', outcome: 'unavailable', reason: 'qualified_gate_unknown' };
  }
  if (artifact === null || artifact === 'unknown' || artifact.expired) {
    return { kind: 'skip', outcome: 'unavailable', reason: 'producer_artifact_unusable' };
  }
  if (plan.master.branch === null) return { kind: 'skip', outcome: 'unavailable', reason: 'master_branch_unknown' };
  return {
    kind: 'send',
    ref: plan.master.branch,
    inputs: {
      ci_run_id: gate.id,
      ci_run_attempt: gate.attempt,
      candidate_sha: candidate,
      build_artifact_id: artifact.id,
    },
  };
}

const clean = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  scrubSecrets(stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''));

/**
 * Default is a structured dry run: evidence plus the proposed dispatch, never
 * a mutation. `apply` re-reads the plan immediately before dispatching and
 * refuses on any change — a moved master, a new attest run, a repointed tag or
 * an evidence read going dark all mean zero dispatches.
 */
export async function advanceReleaseCandidate(repo: string, tag: string, opts: { apply?: boolean; runner?: GitRunner } = {}): Promise<ReleaseAdvanceReport> {
  const runner = opts.runner ?? defaultGitRunner;
  const apply = opts.apply === true;
  const report: ReleaseAdvanceReport = {
    version: 1, repo, tag, apply, outcome: 'unavailable', reason: 'pending',
    planOutcome: 'unavailable',
    candidate: { sha: null, tree: null }, master: { branch: null, sha: null, tree: null },
    masterMoved: null, treeMatch: null, gateRun: null, producerArtifact: null,
    attestedRun: null, inFlightRun: null, release: { state: 'unknown', id: null },
    blockers: [], dispatch: { ref: null, inputs: null, invoked: false, accepted: false, detail: null },
    truncated: false,
  };
  const fill = (plan: ReleaseCandidatePlan): void => {
    report.planOutcome = plan.outcome;
    report.candidate = plan.candidate;
    report.master = plan.master;
    report.masterMoved = plan.masterMoved;
    report.treeMatch = plan.treeMatch;
    report.gateRun = plan.gateRun === null ? null
      : { id: plan.gateRun.id, attempt: plan.gateRun.attempt, conclusion: plan.gateRun.conclusion };
    report.producerArtifact = plan.producerArtifact === null || plan.producerArtifact === 'unknown' ? null
      : { id: plan.producerArtifact.id, name: plan.producerArtifact.name, expired: plan.producerArtifact.expired };
    const attested = plan.attestOnCandidate.find(r => r.conclusion === 'success');
    const inFlight = plan.attestOnCandidate.find(r => r.status !== 'completed');
    report.attestedRun = attested ? { id: attested.id, attempt: attested.attempt } : null;
    report.inFlightRun = inFlight ? { id: inFlight.id, attempt: inFlight.attempt, status: inFlight.status } : null;
    report.release = { state: plan.release.state, id: plan.release.id };
    report.blockers = plan.blockers;
    report.truncated = plan.truncated;
  };

  const first = await planReleaseCandidate(repo, tag, { runner });
  fill(first);
  let decision = decide(first);
  if (decision.kind === 'send') {
    report.dispatch.ref = decision.ref;
    report.dispatch.inputs = decision.inputs;
  }
  report.outcome = decision.kind === 'send' ? 'planned' : decision.outcome;
  report.reason = decision.kind === 'send' ? 'eligible' : decision.reason;
  if (!apply || decision.kind !== 'send') return report;

  // Refresh immediately before the mutation: the tag must still name the same
  // candidate and every dispatch condition must still hold on the new read.
  const fresh = await planReleaseCandidate(repo, tag, { runner });
  fill(fresh);
  report.dispatch.ref = null;
  report.dispatch.inputs = null;
  if (fresh.candidate.sha !== first.candidate.sha) {
    report.outcome = 'refused';
    report.reason = 'changed_before_apply';
    return report;
  }
  decision = decide(fresh);
  if (decision.kind !== 'send') {
    report.outcome = decision.outcome;
    report.reason = decision.reason;
    return report;
  }
  report.dispatch.ref = decision.ref;
  report.dispatch.inputs = decision.inputs;

  report.dispatch.invoked = true;
  const inputs = decision.inputs;
  const sent = await runner('gh', [
    'workflow', 'run', ATTEST_WORKFLOW, '--repo', repo, '--ref', decision.ref,
    '-f', `ci_run_id=${inputs.ci_run_id}`,
    '-f', `ci_run_attempt=${inputs.ci_run_attempt}`,
    '-f', `candidate_sha=${inputs.candidate_sha}`,
    '-f', `build_artifact_id=${inputs.build_artifact_id}`,
  ], { cwd: tmpdir(), timeoutMs: TIMEOUT_MS, maxStdoutBytes: DISPATCH_MAX_BYTES }).catch(() => null);
  if (sent === null || sent.code !== 0 || sent.timedOut || sent.missing || sent.truncated) {
    report.outcome = 'refused';
    report.reason = 'dispatch_rejected';
    const detail = clean(sent?.stderr || sent?.stdout || '').replace(/[\r\n]+/g, ' ').trim();
    report.dispatch.detail = detail ? detail.slice(0, MAX_FIELD) : null;
    return report;
  }
  report.outcome = 'submitted';
  report.reason = 'dispatch_accepted';
  report.dispatch.accepted = true;
  return report;
}
