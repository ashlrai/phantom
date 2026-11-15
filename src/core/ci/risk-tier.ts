import {
  PROTECTED_PATH_RULES,
  globMatches,
  isTestPath,
  matchProtectedPath,
  normalizeRepoPath,
} from '../authority/protected-paths.js';

export type CiRiskTier = 'smoke' | 'full' | 'blocked';
export interface CiRiskDecision {
  schema: 'ci-risk-tier.v1';
  tier: CiRiskTier;
  reasons: { path: string | null; rule: string }[];
}

const secretRules = PROTECTED_PATH_RULES.filter((rule) => rule.id === 'secrets');
const rank: Record<CiRiskTier, number> = { smoke: 0, full: 1, blocked: 2 };
const runtimeDocs = new Set(['docs/north-star.md', 'docs/ecosystem-map.md', 'docs/improvement-backlog.md']);

function blocked(rule: string): CiRiskDecision {
  return { schema: 'ci-risk-tier.v1', tier: 'blocked', reasons: [{ path: null, rule }] };
}

/**
 * Advisory path classification, never merge authority or proof of verification.
 * Supply the COMPLETE diff, including deleted paths and BOTH rename endpoints.
 * A consumer must independently bind exact commits, regular file modes and
 * successful verification before using smoke (see docs/ci/FRICTIONLESS-PATH.md).
 * No Git, content reads, environment inputs, or caller-provided rule overrides.
 */
export function classifyCiRiskTier(paths: unknown): CiRiskDecision {
  if (!Array.isArray(paths) || paths.length === 0) return blocked('missing-diff');
  const unique = new Set<string>();
  const folded = new Map<string, string>();
  for (const path of paths) {
    // Git emits canonical POSIX names. Do not repair ambiguous evidence into a
    // cheaper lane; also reject drive paths/ADS, which the G1 normalizer allows.
    if (typeof path !== 'string' || normalizeRepoPath(path) !== path || path.includes(':')) {
      return blocked('unsafe-path');
    }
    unique.add(path);
  }
  for (const path of unique) {
    const prior = folded.get(path.toLowerCase());
    if (prior !== undefined && prior !== path) return blocked('case-collision');
    folded.set(path.toLowerCase(), path);
  }
  // If the secret rule ever disappears, never silently weaken this classifier.
  if (secretRules.length !== 1) return blocked('missing-secret-policy');

  const result: CiRiskDecision = { schema: 'ci-risk-tier.v1', tier: 'smoke', reasons: [] };
  for (const path of [...unique].sort()) {
    let tier: CiRiskTier = 'full';
    let rule = 'unclassified-path';
    const hit = matchProtectedPath(path, { selfRepo: true });
    // G1 is first-match-wins. Secret material must still block when it also
    // matches an earlier rule, e.g. .github/secrets/key.md or docs/.env.example.
    if (secretRules.some((entry) => entry.patterns.some((pattern) => globMatches(pattern, path)))) {
      tier = 'blocked';
      rule = 'secrets';
    } else if (hit) {
      rule = hit.ruleId;
    } else if (isTestPath(path)) {
      rule = 'test-path';
    } else if (/(^|\/)(?:agents|skill|claude|gemini)\.md$/i.test(path)) {
      rule = 'agent-instructions';
    } else if (runtimeDocs.has(path.toLowerCase()) ||
        /(^|\/)(?:fixtures?|templates?|scripts?)\//i.test(path)) {
      rule = 'runtime-input';
    } else if (!path.split('/').some((part) => part.startsWith('.')) &&
        (path === 'README.md' || path === 'CHANGELOG.md' || /^docs\/.+\.md$/.test(path))) {
      tier = 'smoke';
      rule = 'documentation';
    }
    result.reasons.push({ path, rule });
    if (rank[tier] > rank[result.tier]) result.tier = tier;
  }
  return result;
}
