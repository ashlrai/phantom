/**
 * proof-outcome-join.ts — RQ-PROOF-LOOP-1: read-only join of publisher proof
 * artifacts (`fleet.proof.v1`, written beside `<job>.publish`) to post-merge
 * outcomes (`fleet.eval-report.v1` pull requests), answering "did the proof
 * predict the outcome?".
 *
 * Join key: the eval report's `jobId` → `<resultsDir>/<jobId>.publish` → its
 * single digest-bound `PROOF <file> sha256:<hex>` marker. The marker digest is
 * the stable proof artifact id (`sha256:<hex>`) other consumers can cite.
 *
 * Honesty rules:
 *   - a PR without a jobId, a job without a readable `.publish`/marker, or an
 *     envelope that fails the schema is reported with an explicit state and
 *     null fields; nothing is inferred;
 *   - `verified` means the recorded integrity checks passed (verifyProofResult),
 *     not that tests were semantically sufficient;
 *   - predictive rates resolve over resolved merges only (stable + adverse),
 *     same as eval-report, and carry Wilson intervals;
 *   - proof files and outcomes are only read, never written.
 */
import { dirname, join } from 'node:path';
import { wilsonInterval } from '../eval/router-eval.js';
import type { EvalPullRequest, FleetEvalReport } from './eval-report.js';
import {
  localProofRef,
  PROOF_MAX_BYTES,
  proofEnvelopeSchema,
  proofHash,
  readProofFile,
  verifyProofResult,
  type ProofEnvelope,
  type ProofReview,
} from './proof-envelope.js';

export const FLEET_PROOF_OUTCOMES_SCHEMA = 'fleet.proof-outcomes.v1' as const;

export type ProofState =
  /** Marker + envelope valid and every integrity check passed. */
  | 'verified'
  /** Envelope readable, but verification raised flags (missing tests, unknown risk, ...). */
  | 'needs-review'
  /** `.publish` exists but the proof marker/envelope is missing, mismatched or off-schema. */
  | 'unreadable'
  /** No `.publish` file for the job (or no resultsDir): no proof evidence either way. */
  | 'absent'
  /** The merged PR could not be attributed to a job, so no join was possible. */
  | 'unattributed';

export interface ProofOutcomeRow {
  url: string;
  jobId: string | null;
  lane: string | null;
  tier: string | null;
  durability: EvalPullRequest['durability'];
  proofState: ProofState;
  /** `sha256:<hex>` marker digest; null unless the marker was readable. */
  proofId: string | null;
  riskTier: ProofEnvelope['riskTier'] | null;
  diffStats: ProofEnvelope['diffStats'] | null;
  /** Tool-captured verification commands recorded / failed. */
  verification: { commands: number; failed: number } | null;
  flags: number | null;
  /** Did the proof state agree with the outcome? null when either side is not resolved. */
  predicted: 'correct' | 'wrong' | null;
}

export interface ProofStateRollup {
  state: ProofState;
  merged: number;
  resolved: number;
  stable: number;
  adverse: number;
  pending: number;
  unobserved: number;
  /** stable / resolved; null when nothing resolved. */
  durabilityRate: number | null;
  ci95: [number, number] | null;
}

export interface ProofOutcomeReport {
  schema: typeof FLEET_PROOF_OUTCOMES_SCHEMA;
  generatedAt: string;
  /** Schema of the eval report this was derived from. */
  basedOn: string;
  window: FleetEvalReport['window'];
  resultsDir: { state: 'present' | 'absent' };
  totals: { merged: number; withProof: number; verified: number; absent: number; unreadable: number; unattributed: number };
  byProofState: ProofStateRollup[];
  /** verified durability minus all-other-resolved durability, in rate points; null if either side has no resolved merges. */
  verifiedLift: number | null;
  /** Only verified/needs-review rows count: proof said ok ⇒ stable, flagged ⇒ adverse. */
  prediction: { scored: number; correct: number; accuracy: number | null };
  pullRequests: ProofOutcomeRow[];
}

export interface ProofOutcomeDeps {
  /** Test seam; defaults to the real, hardened verifier. */
  verify?: (publishPath: string) => ProofReview;
  /** Test seam; defaults to a bounded, no-follow file read. null when unreadable. */
  read?: (path: string) => string | null;
}

const ADVERSE = new Set(['reverted', 'regressed', 'followed-up']);
const STATES: ProofState[] = ['verified', 'needs-review', 'unreadable', 'absent', 'unattributed'];

const safeRead = (path: string): string | null => {
  try { return readProofFile(path, PROOF_MAX_BYTES); } catch { return null; }
};

function summarizeProof(jobId: string, resultsDir: string, deps: ProofOutcomeDeps): Pick<ProofOutcomeRow, 'proofState' | 'proofId' | 'riskTier' | 'diffStats' | 'verification' | 'flags'> {
  const none = { proofId: null, riskTier: null, diffStats: null, verification: null, flags: null };
  if (!localProofRef(jobId)) return { proofState: 'absent', ...none };
  const read = deps.read ?? safeRead;
  const publishPath = join(resultsDir, `${jobId}.publish`);
  const publish = read(publishPath);
  if (publish === null) return { proofState: 'absent', ...none };
  const markers = publish.split('\n').filter((line) => line.startsWith('PROOF '));
  const marker = markers.length === 1 ? /^PROOF (\S+) sha256:([a-f0-9]{64})$/.exec(markers[0]!) : null;
  if (!marker || !localProofRef(marker[1]!)) return { proofState: 'unreadable', ...none };
  const raw = read(join(dirname(publishPath), marker[1]!));
  if (raw === null || proofHash(raw) !== marker[2]) return { proofState: 'unreadable', ...none };
  let envelope: ProofEnvelope;
  try { envelope = proofEnvelopeSchema.parse(JSON.parse(raw)); } catch { return { proofState: 'unreadable', ...none }; }
  const review = (deps.verify ?? verifyProofResult)(publishPath);
  return {
    proofState: review.ok ? 'verified' : 'needs-review',
    proofId: `sha256:${marker[2]}`,
    riskTier: envelope.riskTier,
    diffStats: envelope.diffStats,
    verification: { commands: envelope.verification.length, failed: envelope.verification.filter((v) => v.exitCode !== 0).length },
    flags: review.flags.length,
  };
}

export function buildProofOutcomeReport(
  report: FleetEvalReport,
  resultsDir: string | null,
  deps: ProofOutcomeDeps = {},
): ProofOutcomeReport {
  const merged = report.pullRequests.filter((pr) => pr.mergedAt !== null);
  const rows: ProofOutcomeRow[] = merged.map((pr) => {
    const base = { url: pr.url, jobId: pr.jobId, lane: pr.lane, tier: pr.tier, durability: pr.durability };
    const proof = pr.jobId === null
      ? { proofState: 'unattributed' as const, proofId: null, riskTier: null, diffStats: null, verification: null, flags: null }
      : resultsDir === null
        ? { proofState: 'absent' as const, proofId: null, riskTier: null, diffStats: null, verification: null, flags: null }
        : summarizeProof(pr.jobId, resultsDir, deps);
    const resolved = pr.durability === 'stable' || ADVERSE.has(pr.durability);
    let predicted: ProofOutcomeRow['predicted'] = null;
    if (resolved && (proof.proofState === 'verified' || proof.proofState === 'needs-review')) {
      const stable = pr.durability === 'stable';
      predicted = (proof.proofState === 'verified') === stable ? 'correct' : 'wrong';
    }
    return { ...base, ...proof, predicted };
  }).sort((a, b) => a.url.localeCompare(b.url));

  const byProofState: ProofStateRollup[] = STATES.map((state) => {
    const group = rows.filter((r) => r.proofState === state);
    const stable = group.filter((r) => r.durability === 'stable').length;
    const adverse = group.filter((r) => ADVERSE.has(r.durability)).length;
    const resolved = stable + adverse;
    return {
      state, merged: group.length, resolved, stable, adverse,
      pending: group.filter((r) => r.durability === 'pending').length,
      unobserved: group.filter((r) => r.durability === 'unobserved').length,
      durabilityRate: resolved > 0 ? stable / resolved : null,
      ci95: wilsonInterval(stable, resolved),
    };
  });
  const verified = byProofState.find((g) => g.state === 'verified')!;
  const others = byProofState.filter((g) => g.state !== 'verified');
  const otherResolved = others.reduce((n, g) => n + g.resolved, 0);
  const otherStable = others.reduce((n, g) => n + g.stable, 0);
  const verifiedLift = verified.durabilityRate !== null && otherResolved > 0
    ? verified.durabilityRate - otherStable / otherResolved : null;
  const scoredRows = rows.filter((r) => r.predicted !== null);
  const correct = scoredRows.filter((r) => r.predicted === 'correct').length;
  const count = (s: ProofState) => rows.filter((r) => r.proofState === s).length;

  return {
    schema: FLEET_PROOF_OUTCOMES_SCHEMA,
    generatedAt: report.generatedAt,
    basedOn: report.schema,
    window: report.window,
    resultsDir: { state: resultsDir === null ? 'absent' : 'present' },
    totals: {
      merged: rows.length,
      withProof: count('verified') + count('needs-review'),
      verified: count('verified'),
      absent: count('absent'),
      unreadable: count('unreadable'),
      unattributed: count('unattributed'),
    },
    byProofState,
    verifiedLift,
    prediction: { scored: scoredRows.length, correct, accuracy: scoredRows.length > 0 ? correct / scoredRows.length : null },
    pullRequests: rows,
  };
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

export function formatProofOutcomeReport(r: ProofOutcomeReport): string {
  const lines = [
    `Proof ↔ outcome (${r.schema}) ${r.window.since} → ${r.window.until}`,
    `Merged ${r.totals.merged}: verified ${r.totals.verified}, with proof ${r.totals.withProof}, absent ${r.totals.absent}, unreadable ${r.totals.unreadable}, unattributed ${r.totals.unattributed}`,
    ...r.byProofState.filter((g) => g.merged > 0).map((g) =>
      `  ${g.state.padEnd(13)} merged ${g.merged} resolved ${g.resolved} durable ${pct(g.durabilityRate)}${g.ci95 ? ` [${pct(g.ci95[0])}–${pct(g.ci95[1])}]` : ''}`),
    `Verified lift vs rest: ${r.verifiedLift === null ? 'n/a' : `${(r.verifiedLift * 100).toFixed(1)} pts`}`,
    `Proof predicted outcome: ${r.prediction.correct}/${r.prediction.scored} (${pct(r.prediction.accuracy)})`,
  ];
  return lines.join('\n');
}
