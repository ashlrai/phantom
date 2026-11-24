/** Assert every verb row in docs/FLEET-VERBS.md names a source file that exists
and is registered in the generated fleet subcommand registry.

The verb list is read from the doc table itself, so a new row is checked without
editing this test. The test does NOT assert the reverse: new fleet verbs may land
before the doc is updated. That is intentional: doc lags source, source never
breaks.
*/

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import * as assert from 'node:assert';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROW = /^\| ([a-z0-9-]+) \| `(src\/cli\/fleet-[a-z0-9-]+\.ts)` \|/;

const ROWS = readFileSync(join(ROOT, 'docs', 'FLEET-VERBS.md'), 'utf8')
  .split('\n')
  .map(line => ROW.exec(line))
  .filter((m): m is RegExpExecArray => m !== null)
  .map(m => ({ verb: m[1]!, file: m[2]! }));

describe('docs/FLEET-VERBS.md verbs', () => {
  it('lists verbs', () => {
    assert.ok(ROWS.length > 50, `expected a populated table, parsed ${ROWS.length} rows`);
  });
  for (const { verb, file } of ROWS) {
    it(`${verb}: ${file} exists and is registered`, () => {
      assert.ok(existsSync(join(ROOT, file)), `${file} is documented but missing`);
      assert.ok(verb in FLEET_SUBCOMMAND_LOADERS, `fleet ${verb} is documented but not in the registry`);
    });
  }
});
