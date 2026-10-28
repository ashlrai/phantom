import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTests } from './affected-tests.mjs';

test('selects transitive imports and falls back for uncertain changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'affected-fixture-'));
  const contents = {
    'src/value.ts': 'export const value = 1;',
    'src/text-only.ts': 'export const text = 1;',
    'src/consumer.ts': "export { value } from './value.js';",
    'test/value.test.ts': "import { value } from '../src/consumer.js';",
    'test/helpers/shared.ts': 'export const shared = 1;',
  };
  try {
    for (const [file, text] of Object.entries(contents)) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), text);
    }
    const input = { directory, files: Object.keys(contents), map: {} };
    assert.deepEqual(selectTests({ ...input, changed: ['src/value.ts'] }), ['test/value.test.ts']);
    assert.equal(selectTests({ ...input, changed: ['test/helpers/shared.ts'] }), 'ALL');
    assert.equal(selectTests({ ...input, changed: ['unknown.txt'] }), 'ALL');
    assert.equal(selectTests({ ...input, changed: ['package-lock.json'] }), 'ALL');
    assert.equal(selectTests({ ...input, changed: ['src/text-only.ts'] }), 'ALL');
    assert.deepEqual(selectTests({ ...input, changed: ['src/text-only.ts'], map: { 'src/text-only.ts': ['test/value.test.ts'] } }), ['test/value.test.ts']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
