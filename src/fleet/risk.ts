/** Deterministic advisory scoring. This module grants no merge authority. */
import {
  detectTestTampering,
  isTestPath,
  normalizeRepoPath,
  protectedPathHits,
  testContentImportsTier1,
  diffAddedLinesByPath,
  type ProtectedPathOptions,
} from '../core/authority/protected-paths.js';
import { measureAutoMergeDiffScope } from '../core/foundry/automerge-diff-scope.js';

export type DiffRiskLevel = 'low' | 'medium' | 'high';

export interface DiffRiskFactor {
  code: 'unmeasurable' | 'protected-path' | 'sensitive-path' | 'unknown-path' |
    'path-class' | 'size' | 'test-delta' | 'test-tampering' | 'executable-mode';
  /** Additive points; floors below cannot be offset by a positive test delta. */
  points: number;
  minimum: number;
  paths: string[];
}

export interface DiffRiskMetrics {
  files: number;
  additions: number;
  deletions: number;
  changedLines: number;
  testFiles: number;
  testAdditions: number;
  testDeletions: number;
  testDelta: number;
}

export interface DiffRiskAssessment {
  /** Bump when scoring weights or semantics change; consumers can pin policy. */
  policyVersion: 'diff-risk/v1';
  score: number;
  risk: DiffRiskLevel;
  measurable: boolean;
  invalidReason: string | null;
  metrics: DiffRiskMetrics | null;
  factors: DiffRiskFactor[];
}

const SOURCE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|rb|php|c|cc|cpp|h|cs|vue|svelte|css|scss|mdx)$/;
const CONFIG = /\.(?:json|ya?ml|toml|ini|cfg)$/;
const DOC = /\.(?:md|rst|txt)$|(?:^|\/)(?:license|licence|notice)(?:\.[^/]+)?$/;
// Keep the existing merge classifier's sensitive classes high even when this
// advisory feed is used for another repo (where Phantom Tier-1 rules do not apply).
const SENSITIVE = /(?:^|\/)(?:auth|authn|authz|authentication|authorization|security|secret|credential|crypto|token|password|policy|sandbox|permission|rbac|acl|login|session|migration|script|bin)s?(?:[./_-]|$)|\.(?:sh|bash|zsh|ps1|sql|pem|key|p12|pfx|dockerfile)$|(?:^|\/)(?:dockerfile|makefile)(?:\.|$)/;

/**
 * Score a complete canonical git patch, never a truncated preview. Defaults to
 * Phantom's self-repo protection; other repos must explicitly opt out. Existing
 * grant, review, CI, Stop/Pause and owner-lane checks remain authoritative.
 * Tests added are a coverage signal, not proof of test quality or execution.
 */
export function scoreDiffRisk(
  diff: string | null | undefined,
  options: ProtectedPathOptions = { selfRepo: true },
): DiffRiskAssessment {
  const scope = measureAutoMergeDiffScope(diff);
  const invalid = (reason: string): DiffRiskAssessment => ({
    policyVersion: 'diff-risk/v1', score: 100, risk: 'high', measurable: false,
    invalidReason: reason, metrics: null,
    factors: [{ code: 'unmeasurable', points: 0, minimum: 100, paths: [] }],
  });
  if (!scope.ok) return invalid(scope.reason);
  if (scope.touchedPaths.some((path) => normalizeRepoPath(path) === null || /^[a-z]:/i.test(path))) {
    return invalid('unsafe-path');
  }
  // The strict scope parser validates hunk counts before the existing tampering
  // scanner sees content. Both must understand the patch; ambiguity is high risk.
  const tampering = detectTestTampering(diff!);
  if (tampering.parseError) return invalid('test-delta-unreadable');
  const added = diffAddedLinesByPath(diff!);
  if (!added) return invalid('test-delta-unreadable');
  const testsImportingTier1 = new Set(options.testsImportingTier1);
  for (const [path, lines] of added) {
    const normalized = normalizeRepoPath(path)!;
    if (isTestPath(normalized) && testContentImportsTier1(normalized, [lines.join('\n')])) testsImportingTier1.add(normalized);
  }

  const factors: DiffRiskFactor[] = [];
  const factor = (code: DiffRiskFactor['code'], points: number, minimum: number, paths: string[] = []) => {
    factors.push({ code, points, minimum, paths: [...new Set(paths)].sort() });
  };
  const paths = scope.touchedPaths;
  const protectedHits = protectedPathHits(paths, { ...options, testsImportingTier1 });
  if (protectedHits.length) factor('protected-path', 0, 85, protectedHits.map((hit) => hit.path));
  const sensitive = paths.filter((path) => SENSITIVE.test(normalizeRepoPath(path)!.toLowerCase()));
  if (sensitive.length) factor('sensitive-path', 0, 85, sensitive);
  const unknown = paths.filter((path) => {
    const lower = normalizeRepoPath(path)!.toLowerCase();
    return !isTestPath(path) && !DOC.test(lower) && !SOURCE.test(lower) && !CONFIG.test(lower);
  });
  if (unknown.length) factor('unknown-path', 0, 70, unknown);
  if (/^(?:(?:new file mode|deleted file mode|old mode|new mode) 100755|index [^\r\n]+ 100755)\r?$/m.test(diff!)) {
    factor('executable-mode', 0, 85);
  }

  const source = paths.filter((path) => !isTestPath(path) && SOURCE.test(path.toLowerCase()));
  const config = paths.filter((path) => !isTestPath(path) && CONFIG.test(path.toLowerCase()));
  const testEntries = scope.entries.filter((entry) =>
    (entry.oldPath !== null && isTestPath(entry.oldPath)) ||
    (entry.newPath !== null && isTestPath(entry.newPath)));
  const testAdditions = testEntries.reduce((sum, entry) => sum + entry.additions, 0);
  const testDeletions = testEntries.reduce((sum, entry) => sum + entry.deletions, 0);
  const pathPoints = config.length ? 35 : source.length ? 30 : testEntries.length ? 5 : 0;
  factor('path-class', pathPoints, 0, config.length ? config : source.length ? source :
    paths.filter(isTestPath));
  // Preserve the existing classifier's hard size boundaries. Churn counts both
  // additions and deletions, so replacing 201 lines exceeds the 400-line limit.
  factor('size', scope.files > 5 || scope.changedLines > 100 ? 15 : scope.changedLines > 20 ? 5 : 0,
    scope.files > 10 || scope.changedLines > 400 ? 70 : 0);
  if (source.length) factor('test-delta', testEntries.length === 0 ? 15 : testAdditions <= testDeletions ? 10 : 0, 0);
  const shrinkingTests = testEntries.filter((entry) => entry.deletions > entry.additions);
  if (shrinkingTests.length) factor('test-delta', 0, 70,
    shrinkingTests.map((entry) => entry.oldPath ?? entry.newPath!));
  if (tampering.findings.length) factor('test-tampering', 0, 85, tampering.findings.map((finding) => finding.path));
  const score = Math.min(100, Math.max(
    factors.reduce((sum, entry) => sum + entry.points, 0),
    ...factors.map((entry) => entry.minimum),
  ));
  return {
    policyVersion: 'diff-risk/v1', score,
    risk: score < 25 ? 'low' : score < 70 ? 'medium' : 'high',
    measurable: true, invalidReason: null,
    metrics: { files: scope.files, additions: scope.additions, deletions: scope.deletions,
      changedLines: scope.changedLines, testFiles: testEntries.length,
      testAdditions, testDeletions, testDelta: testAdditions - testDeletions },
    factors,
  };
}
