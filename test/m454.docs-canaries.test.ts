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
  it('keeps operator guides free of m454 fixture consumers', () => {
    // Newly admitted operator guides remain documentation, not m454 fixture consumers.
    for (const path of [
      'docs/RESIDENT-RUNTIME.md', 'docs/AUTHORITY.md', 'docs/STANDING-AUTHORITY.md',
      'docs/CLOUD.md', 'docs/LEADER.md', 'docs/DEVIN.md', 'docs/VERSE-CONTEXT.md',
      'docs/VERSE-BROWSER.md', 'docs/JEV-INTEGRATION.md', 'docs/COMPANIONS.md',
      'docs/MEMORY-FOUNDATION.md', 'docs/MEMORY-EVALUATION.md',
      'docs/PROACTIVE-COORDINATION.md', 'docs/PROACTIVE-COORDINATION-BACKLOG.md',
      'docs/RESOURCE-POOL-COMMISSIONING-CHECK.md',
    ]) {
      const source = readFileSync(join(REPO_ROOT, path), 'utf8');
      for (const canary of CONSUMER_CANARIES) expect(source).not.toContain(canary);
    }
  });
});
