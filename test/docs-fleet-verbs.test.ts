/** Assert every verb listed in docs/FLEET-VERBS.md still has its source file on disk.

Note: this test does NOT assert the reverse — new fleet verbs may land before
the doc is updated. That is intentional: doc lags source, source never breaks.
*/

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli');

const VERBS = [
  'backlog',
  'bet-trace',
  'bus-thread',
  'canary-ladder',
  'ci-failures',
  'ci-nightly',
  'class-share',
  'dead-heads',
  'dispatch-summary',
  'edit-collisions',
  'grok-usage',
  'job-class-share',
  'job-read',
  'lane-models',
  'lane-truth',
  'launch-proof',
  'meter-drop',
  'real-supply',
  'runs-read',
  'ship-gap',
  'stray-slots',
  'wait-jobs',
  'workers',
];

describe('docs/FLEET-VERBS.md verbs', () => {
  for (const verb of VERBS) {
    it(`src/cli/fleet-${verb}.ts exists`, () => {
      const path = join(CLI_ROOT, `fleet-${verb}.ts`);
      assert.ok(existsSync(path), `fleet-${verb}.ts should exist`);
    });
  }
});
