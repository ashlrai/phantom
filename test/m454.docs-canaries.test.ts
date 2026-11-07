import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Split from m454.agent-skills-routing-challenge.test.ts, which needs a built
// dist and so is skipped by the docs-only lane. This scan reads docs only, so
// it stays in the docs lane and a docs-only PR cannot add an m454 consumer.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONSUMER_CANARIES = [
  'agent-skills-ff2df4c',
  'CONTRACT-M454',
  'ff2df4c07e7836a092ed28e1e9b42f4d6009280c',
];

describe('M454 docs canaries', () => {
  it('keeps the companion guide link and the Secrets autonomy boundary available', () => {
    const companions = readFileSync(join(REPO_ROOT, 'docs/COMPANIONS.md'), 'utf8');
    const secrets = readFileSync(join(REPO_ROOT, 'docs/SECRETS-FOR-ENROLLED-REPOS.md'), 'utf8');
    expect(companions).toContain('https://github.com/ashlrai/phantom/blob/master/docs/SECRETS-FOR-ENROLLED-REPOS.md');
    expect(secrets).toContain('Trusted-terminal challenge; not autonomous');
    expect(secrets).toContain('Hard-denied in Secrets v0.7.9');
    expect(secrets).toContain('[STANDING-AUTHORITY.md](STANDING-AUTHORITY.md)');
  });

  it('keeps operator guides free of m454 fixture consumers', () => {
    // Newly admitted operator guides remain documentation, not m454 fixture consumers.
    for (const path of [
      'docs/RESIDENT-RUNTIME.md', 'docs/AUTHORITY.md', 'docs/STANDING-AUTHORITY.md',
      'docs/CLOUD.md', 'docs/LEADER.md', 'docs/DEVIN.md', 'docs/VERSE-CONTEXT.md',
      'docs/VERSE-BROWSER.md', 'docs/JEV-INTEGRATION.md', 'docs/COMPANIONS.md',
      'docs/SECRETS-FOR-ENROLLED-REPOS.md',
      'docs/MEMORY-FOUNDATION.md', 'docs/MEMORY-EVALUATION.md',
      'docs/PROACTIVE-COORDINATION.md', 'docs/PROACTIVE-COORDINATION-BACKLOG.md',
      'docs/RESOURCE-POOL-COMMISSIONING-CHECK.md',
    ]) {
      const source = readFileSync(join(REPO_ROOT, path), 'utf8');
      for (const canary of CONSUMER_CANARIES) expect(source).not.toContain(canary);
    }
  });
});
