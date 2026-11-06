import { createHash } from 'node:crypto';
import { scoreDiffRisk, type DiffRiskAssessment } from './risk.js';

export interface XReviewRiskInput {
  baseSha: string;
  headSha: string;
  diff: string | null | undefined;
  selfRepo?: boolean;
  /** Full-file import evidence collected by the host, including the old side. */
  testsImportingTier1?: ReadonlySet<string>;
}

export interface XReviewRiskEvidence {
  schema: 'xreview-risk/v1';
  baseSha: string;
  headSha: string;
  diffSha256: string | null;
  /** Queue ordering only. This never satisfies a required review or CI check. */
  reviewPriority: 'expedited' | 'standard' | 'escalated';
  assessment: DiffRiskAssessment;
}

/**
 * XREVIEW's serializable risk feed, bound to an exact base, head and patch.
 * Recompute after any rebase or head change. No XREVIEW runner exists in this
 * checkout yet; this is the advisory boundary for that consumer, not a gate.
 */
export function assessDiffForXReview(input: XReviewRiskInput): XReviewRiskEvidence {
  if (![input.baseSha, input.headSha].every((sha) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))) {
    throw new Error('XREVIEW risk evidence requires full lowercase base and head commit SHAs');
  }
  const assessment = scoreDiffRisk(input.diff, {
    selfRepo: input.selfRepo ?? true, testsImportingTier1: input.testsImportingTier1,
  });
  return {
    schema: 'xreview-risk/v1', baseSha: input.baseSha, headSha: input.headSha,
    diffSha256: typeof input.diff === 'string' ? createHash('sha256').update(input.diff).digest('hex') : null,
    reviewPriority: assessment.risk === 'low' ? 'expedited' : assessment.risk === 'medium' ? 'standard' : 'escalated',
    assessment,
  };
}
