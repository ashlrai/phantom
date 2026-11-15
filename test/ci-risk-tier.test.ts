import { describe, expect, it } from 'vitest';
import { classifyCiRiskTier } from '../src/core/ci/risk-tier.js';

describe('CI risk tier', () => {
  it('admits only ordinary documentation to smoke', () => {
    expect(classifyCiRiskTier(['README.md', 'CHANGELOG.md', 'docs/guide with spaces.md', 'docs/ci/plan.md']).tier)
      .toBe('smoke');
  });

  it.each([
    ['.github/workflows/ci.yml', 'ci-config'],
    ['docs/CODEOWNERS', 'codeowners'],
    ['docs/package.json', 'manifest'],
    ['docs/tsconfig.json', 'verify-config'],
    ['docs/Makefile', 'build-and-hooks'],
    ['scripts/build-new.mjs', 'release-tooling'],
    ['docs/nested/new-authority.md', 'authority-doc'],
    ['src/core/authority/new.ts', 'tier1-authority-code'],
    ['test/setup/new.ts', 'tier1-test-infra'],
    ['test/new-authority.test.ts', 'tier1-test'],
    ['test/h1.new.test.ts', 'tier1-test'],
  ])('keeps protected path %s full with the canonical rule id', (path, rule) => {
    expect(classifyCiRiskTier([path])).toMatchObject({ tier: 'full', reasons: [{ path, rule }] });
  });

  it.each([
    'src/core/helper.ts', 'src/web-ui/screen.tsx', 'desktop/src/main.rs',
    'src/core/comms-agent/new.ts',
    'scripts/verify-changed.mjs', 'src/core/ci/risk-tier.ts', 'test/ci-risk-tier.test.ts',
    'test/innocent-name.test.ts', 'docs/tests/fixture.md', 'docs/__snapshots__/value.md',
    'docs/run.sh', 'docs/page.mdx', 'docs/logo.svg',
    'docs/.config/README.md', 'docs/AGENTS.md', 'docs/SKILL.md', 'docs/CLAUDE.md',
    'AGENTS.md', 'CONSTITUTION.md', 'notes.md', '.github/README.md',
    'contrib/mac/publish.sh', 'contrib/mac/sandbox.sb', 'new-area/README.md',
    'docs/NORTH-STAR.md', 'docs/ECOSYSTEM-MAP.md', 'docs/IMPROVEMENT-BACKLOG.md',
    'docs/templates/agent.md', 'docs/fixtures/value.md', 'docs/scripts/readme.md',
  ])('fails closed to full for non-allowlisted path %s', (path) => {
    expect(classifyCiRiskTier([path]).tier).toBe('full');
  });

  it.each(['docs/.env.example', '.github/secrets/guide.md', 'docs/key.pem', 'DOCS/SECRET.KEY', 'src/core/secrets/README.md'])(
    'blocks secret paths even when another protected rule matches first: %s', (path) => {
      expect(classifyCiRiskTier([path])).toMatchObject({ tier: 'blocked', reasons: [{ path, rule: 'secrets' }] });
    });

  it.each([undefined, null, {}, 'README.md', [], [null], [42], Array(1)])(
    'blocks absent or malformed evidence %#', (input) => {
      expect(classifyCiRiskTier(input).tier).toBe('blocked');
    });

  it.each([
    '', '/docs/a.md', '../README.md', './README.md', 'docs/../README.md', 'docs//a.md',
    'docs\\a.md', 'C:/docs/a.md', 'docs/a.md:stream', 'docs/a.md\n', 'docs/a\0.md',
    '.git/config', 'docs/.GIT/config', 'docs/a.md/', 'a'.repeat(4097),
  ])('blocks ambiguous paths without echoing their contents %#', (path) => {
    expect(classifyCiRiskTier(['README.md', path])).toEqual({
      schema: 'ci-risk-tier.v1', tier: 'blocked', reasons: [{ path: null, rule: 'unsafe-path' }],
    });
  });

  it('matches protected paths case-insensitively but never widens the smoke allowlist', () => {
    expect(classifyCiRiskTier(['DOCS/NEW-AUTHORITY.MD']).reasons[0]?.rule).toBe('authority-doc');
    expect(classifyCiRiskTier(['DOCS/guide.md']).tier).toBe('full');
    expect(classifyCiRiskTier(['docs/guide.MD']).tier).toBe('full');
  });

  it('blocks case-fold collisions including case-only renames on macOS', () => {
    expect(classifyCiRiskTier(['docs/A.md', 'docs/a.md'])).toMatchObject({
      tier: 'blocked', reasons: [{ path: null, rule: 'case-collision' }],
    });
    const malformed = ['docs/A.md', 'docs/a.md', '../secret'];
    expect(classifyCiRiskTier(malformed)).toEqual(classifyCiRiskTier([...malformed].reverse()));
  });

  it('keeps deleted/renamed source paths full when paired with a new docs path', () => {
    expect(classifyCiRiskTier(['src/core/authority/removed.ts', 'docs/moved.md']).tier).toBe('full');
    expect(classifyCiRiskTier(['.env', 'docs/moved.md']).tier).toBe('blocked');
  });

  it('is deterministic, deduplicated, nonmutating and monotone across mixed tiers', () => {
    const paths = Object.freeze(['docs/z.md', 'README.md', 'docs/z.md']);
    const smoke = classifyCiRiskTier(paths);
    expect(smoke).toEqual(classifyCiRiskTier(['README.md', 'docs/z.md']));
    expect(smoke.reasons.map((reason) => reason.path)).toEqual(['README.md', 'docs/z.md']);
    const full = [...paths, 'src/new.ts'];
    expect(classifyCiRiskTier(full).tier).toBe('full');
    const blocked = [...full, 'private.key'];
    expect(classifyCiRiskTier(blocked).tier).toBe('blocked');
    expect(classifyCiRiskTier(blocked)).toEqual(classifyCiRiskTier(blocked.reverse()));
    expect(paths).toHaveLength(3);
  });
});
