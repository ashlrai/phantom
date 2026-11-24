/**
 * tier1-verify (RQ-TIER1-AGENTIC-1): the agentic deep-verification stage that
 * replaces "park for Mason review" on Tier-1 / CODEOWNERS / sensitive PRs.
 * Article 1 (AGENTS.md): no ask-Mason steps; the reviewer does not have to be
 * human. The GATES v3 floor is NOT part of this stage and still holds:
 * CI config / workflow diffs, secret material and secret-shaped values, the
 * secret gate and other Security-pinned files (publish.sh, scrub, dispatchd,
 * git-safe), release/signing tooling, sandbox profiles, the TCC helper and
 * loopback auth, comms send policy, KILL home, billing and payments, edits
 * to CODEOWNERS itself, and
 * credential reads or download-exec in added code.
 *
 * Everything here is PURE: the deterministic half of the stage (floor
 * classification, secret-shape scan, authority-fixture impact, regression
 * risk) and the fix-job queue line for a failed verification. The two model
 * reviews and the full-CI check live in cross-review.ts / cross-review-run.ts.
 */
import { detectTestTampering, diffAddedLinesByPath, isTestPath, protectedPathHits } from '../authority/protected-paths.js';
import { noWs, quoted, securityPinnedPath, singleLine } from '../drive/queuegen.js';
import { QUEUE_TIER_SCOPE } from '../drive/queue-tier.js';
import { scoreDiffRisk } from '../../fleet/risk.js';

export const TIER1_STAGE = 'tier1-verify' as const;

/** protected-paths.ts rule ids that are GATES v3 floor: never agentically merged. */
export const TIER1_FLOOR_RULES: ReadonlySet<string> = new Set([
  'ci-config', 'secrets', 'release-tooling', 'action-classes', 'comms-agent', 'real-home', 'unsafe-path',
  // CODEOWNERS is the server-side owner lane: a rename, deletion or a broad last-match
  // rule can disable ownership with no removed line, so any edit to it stays floor.
  'codeowners',
]);

/**
 * Floor surfaces protected-paths.ts does not name on its own (GATES v3 list,
 * billing). Matched against the WHOLE lowercased path, so a directory such as
 * `src/billing/` or `macos/tcc/` is caught, not only a basename.
 */
export const TIER1_FLOOR_PATH_RE =
  /\.sb$|sandbox-profile|(?:^|[/_.-])tcc(?:[/_.-]|$)|maccu|loopback-auth|leader-wrapper|leader-prompt|billing|payment|stripe|(?:^|\/)codeowners$/i;

/** Scan codes that can never be verified agentically (unreadable input or owner denylist). */
const FLOOR_SCAN_CODES: ReadonlySet<string> = new Set([
  'diff-empty', 'diff-unparseable', 'diff-binary', 'diff-too-large', 'bridge-denylist',
]);
/** Content flags that stay floor: credential reads and executing downloaded code. */
const FLOOR_CONTENT_FLAGS: ReadonlySet<string> = new Set(['env-or-credential-read', 'download-exec']);

/**
 * High-confidence secret VALUE shapes (not generic hex/base64, which test
 * fixtures carry). A hit is floor: an actual secret never merges agentically.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN[ A-Z]*PRIVATE KEY-----/,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[poursa]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /(?<![A-Za-z0-9_-])xai-[A-Za-z0-9]{40,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/,
];

export type Tier1FloorCode =
  | 'floor-scan' | 'floor-protected-rule' | 'floor-security-pin' | 'floor-path' | 'floor-content' | 'floor-secret-shape';

export type Tier1FailureCode =
  | 'test-tamper' | 'regression-too-large' | 'regression-tests-shrink' | 'regression-untested';

export interface Tier1Assessment {
  stage: typeof TIER1_STAGE;
  /** Non-empty ⇒ GATES v3 floor: the PR escalates exactly as before. */
  floor: Tier1FloorCode[];
  /** Non-empty ⇒ deterministic verification failed: reject and queue a fix job. */
  failures: Tier1FailureCode[];
  /** Structured authority-fixture impact (rule ids and counts; never paths or text). */
  authority: { rules: string[]; tier1Source: number; tier1Tests: number; fixtures: number; codeowners: boolean };
  /** Number of added lines with a secret-value shape (values are never recorded). */
  secretShapeHits: number;
  regression: { score: number; risk: 'low' | 'medium' | 'high' };
}

/**
 * The deterministic half of tier1-verify over the EXACT diff the reviewers
 * saw. `scanCodes` / `contentFlags` come from scanSensitiveChange; `paths`
 * from diffPathsForReview (null when unparseable ⇒ floor).
 */
export function assessTier1(input: {
  diff: string;
  paths: readonly string[] | null;
  selfRepo: boolean;
  scanCodes: readonly string[];
  contentFlags: readonly string[];
}): Tier1Assessment {
  const floor = new Set<Tier1FloorCode>();
  const failures = new Set<Tier1FailureCode>();
  const paths = input.paths ?? [];
  if (input.paths === null || input.scanCodes.some((code) => FLOOR_SCAN_CODES.has(code))) floor.add('floor-scan');
  const added = input.paths === null ? null : diffAddedLinesByPath(input.diff);
  if (added === null) floor.add('floor-scan');
  if (input.contentFlags.some((flag) => FLOOR_CONTENT_FLAGS.has(flag))) floor.add('floor-content');

  const hits = protectedPathHits(paths, { selfRepo: input.selfRepo });
  if (hits.some((hit) => TIER1_FLOOR_RULES.has(hit.ruleId))) floor.add('floor-protected-rule');
  if (paths.some(securityPinnedPath)) floor.add('floor-security-pin');
  if (paths.some((p) => TIER1_FLOOR_PATH_RE.test(p))) floor.add('floor-path');

  let secretShapeHits = 0;
  for (const lines of added?.values() ?? []) {
    for (const line of lines) if (SECRET_SHAPES.some((re) => re.test(line))) secretShapeHits += 1;
  }
  if (secretShapeHits > 0) floor.add('floor-secret-shape');

  // Authority-fixture impact: what the change touches (counts and rule ids only).
  const rules = [...new Set(hits.map((hit) => hit.ruleId))].sort();
  const codeowners = paths.some((p) => /(?:^|\/)codeowners$/i.test(p));
  const tamper = detectTestTampering(input.diff);
  if (tamper.parseError === null && tamper.findings.length > 0) failures.add('test-tamper');

  const risk = scoreDiffRisk(input.diff, { selfRepo: input.selfRepo });
  // protected/sensitive minimums are WHY the PR is here; the stage judges the rest.
  const factor = (code: string, minimum?: number) =>
    risk.factors.some((f) => f.code === code && (minimum === undefined || f.minimum >= minimum));
  // An unmeasurable diff cannot be repaired by a fix push: floor, not a fix job.
  if (!risk.measurable) floor.add('floor-scan');
  if (factor('size', 70)) failures.add('regression-too-large');
  if (factor('test-delta', 70)) failures.add('regression-tests-shrink');
  if (risk.metrics && risk.metrics.testFiles === 0 && paths.some((p) => !isTestPath(p) && /\.(?:[cm]?[jt]sx?|py|rs|go|swift)$/i.test(p))) {
    failures.add('regression-untested');
  }

  return {
    stage: TIER1_STAGE,
    floor: [...floor].sort(),
    failures: [...failures].sort(),
    authority: {
      rules,
      tier1Source: hits.filter((hit) => hit.ruleId === 'tier1-authority-code').length,
      tier1Tests: hits.filter((hit) => hit.ruleId === 'tier1-test' || hit.ruleId === 'tier1-test-infra').length,
      fixtures: paths.filter((p) => /^test\/fixtures\/authority\//.test(p) || /(?:^|\/)tier1[^/]*snapshot/i.test(p)).length,
      codeowners,
    },
    secretShapeHits,
    regression: { score: risk.score, risk: risk.risk },
  };
}

/** True when a successful check name satisfies a fullChecks entry (exact, or `prefix*`). */
export function fullCheckSatisfied(pattern: string, succeeded: readonly string[]): boolean {
  return pattern.endsWith('*')
    ? succeeded.some((name) => name.startsWith(pattern.slice(0, -1)))
    : succeeded.includes(pattern);
}

export function tier1FixJobId(repo: string, pr: number, headSha: string): string {
  return `RQ-T1FIX-${repo.split('/').pop()}-${pr}-${headSha.slice(0, 7)}`;
}

/**
 * The router-queue line a failed tier1-verify enqueues instead of parking the
 * PR for a human. One physical line, queuegen grammar (sanitized fields only):
 * the failure codes are enumerated, never free model text.
 */
export function tier1FixJobLine(input: {
  repo: string; pr: number; headSha: string; headRef?: string | null; codes: readonly string[]; stamp: string;
}): string {
  const short = input.repo.split('/').pop() ?? input.repo;
  const scope = QUEUE_TIER_SCOPE.frontier;
  const branch = input.headRef ? ` branch=${noWs(input.headRef, 120)}` : '';
  const text = `TIER1-FIX ${short}#${input.pr}${branch} head=${noWs(input.headSha.slice(0, 7), 12)} failed="${quoted(input.codes.join(', '), 300)}" acceptance="phm fleet xreview run --request <file>": tier1-verify rejected this Tier-1 PR; fix every listed failure (scope the diff to its title, add or restore tests, keep CODEOWNERS and authority fixtures intact) and push to the head branch. See docs/CROSS-REVIEW.md#tier1-verify. https://github.com/${input.repo}/pull/${input.pr}`;
  return `- READY ${tier1FixJobId(input.repo, input.pr, input.headSha)} (P1, pool=any, tier=frontier, repo=${short}, after none, tier1-verify ${noWs(input.stamp, 40)}, max-files=${scope.maxFiles}, size<=${scope.maxLines}): ${singleLine(text)}`;
}
