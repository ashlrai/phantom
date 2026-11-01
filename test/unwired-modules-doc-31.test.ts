import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

const paths = [
  'src/core/fleet/skill-routing-calibration-snapshot.ts',
  'src/core/fleet/automerge-canary-ladder.ts',
  'src/core/fleet/one-ask-reward.ts',
  'src/core/fleet/adapters/grok-peers.ts',
  'src/core/fleet/adapters/codex-peers.ts',
];

describe('unwired-modules-doc-31: every path in the doc exists', () => {
  it.each(paths)('src/%s exists on disk', (p) => {
    expect(existsSync(join(root, p))).toBe(true);
  });
});
