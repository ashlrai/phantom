/**
 * RQ-PHX-REDTESTFIXC166 — regression for PR #5110's only red check.
 *
 * #5110 added src/core/comms/teammate-reply-gap.ts and imported it at runtime
 * from src/core/comms/owner-thread.ts (a Tier-1 closure root). The file joined
 * the Tier-1 authority import closure, so test/authority-tier1-closure-310b
 * failed with "the runtime import closure has not grown" until the reviewed
 * snapshot was regenerated. This pins that reviewed membership: if the module
 * is dropped or the snapshot loses it, this fails.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('redfix-c166: teammate reply gap stays inside the reviewed Tier-1 closure', () => {
  it('the closure snapshot lists src/core/comms/teammate-reply-gap.ts', () => {
    const snapshot = JSON.parse(
      readFileSync(join(ROOT, 'test', 'fixtures', 'authority', 'tier1-closure.json'), 'utf8'),
    ) as { closure: string[] };
    expect(snapshot.closure).toContain('src/core/comms/teammate-reply-gap.ts');
  });

  it('owner-thread.ts imports the module at runtime (not type-only)', () => {
    const source = readFileSync(join(ROOT, 'src', 'core', 'comms', 'owner-thread.ts'), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*teammateReplyGapFromInbox[^}]*\}\s*from\s*'\.\/teammate-reply-gap\.js'/);
  });
});
