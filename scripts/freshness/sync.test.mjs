import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { regenerate, renderBlock, synchronize } from './sync.mjs';

const facts = { version: '3.0.0', released: '2.9.0', date: '2026-10-01' };
for (const [name, expected] of [
  ['version-badge', 'source-3.0.0-blue'],
  ['install-snippet', 'npm install -g @ashlr/phantom@2.9.0'],
  ['version-table', '| Latest dated changelog release (2026-10-01) | 2.9.0 |'],
  ['example-version-pin', 'npx --package=@ashlr/phantom@2.9.0 phm --version'],
]) {
  test(`regenerates ${name} and preserves surrounding content`, () => {
    const before = `keep\n<!-- fresh:begin ${name} -->\nstale\n<!-- fresh:end -->\nhistory\n`;
    const after = regenerate(before, facts);
    assert.ok(after.includes(expected));
    assert.equal(after, `keep\n<!-- fresh:begin ${name} -->\n${renderBlock(name, facts)}\n<!-- fresh:end -->\nhistory\n`);
    assert.equal(regenerate(after, facts), after);
  });
}

test('rejects unknown, nested, unclosed, unmatched and malformed blocks', () => {
  for (const text of [
    '<!-- fresh:begin missing -->\n<!-- fresh:end -->',
    '<!-- fresh:begin version-table --><!-- fresh:begin version-table -->',
    '<!-- fresh:begin version-table -->', '<!-- fresh:end -->',
    '<!-- fresh:begin Version-table -->',
  ]) assert.throws(() => regenerate(text, facts));
});

test('preserves CRLF and repeated block instances', () => {
  const text = '<!-- fresh:begin version-table -->\r\nstale\r\n<!-- fresh:end -->\r\n';
  const generated = regenerate(text + text, facts);
  assert.equal(generated.match(/Source package/g).length, 2);
  assert.ok(!/(?<!\r)\n/.test(generated));
});

test('CLI detects seeded drift, sync repairs it, and check is read-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'phantom-freshness-'));
  try {
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, 'examples'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@ashlr/phantom', version: facts.version }));
    const history = '## [3.0.0] - Unreleased\n\n## [2.9.0] - 2026-10-01\n\nHistorical pin 1.0.0\n';
    writeFileSync(join(root, 'CHANGELOG.md'), history);
    const stale = '<!-- fresh:begin version-badge -->\nseeded drift\n<!-- fresh:end -->\n';
    writeFileSync(join(root, 'README.md'), stale);
    const run = (script) => spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), '--root', root], { encoding: 'utf8' });
    const check = run('check.mjs');
    assert.equal(check.status, 1, check.stderr);
    assert.match(check.stdout, /drift: README.md/);
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), stale);
    assert.equal(run('sync.mjs').status, 0);
    assert.equal(run('check.mjs').status, 0);
    assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), history);
    assert.deepEqual(synchronize(root), []);
    // A later malformed document prevents even earlier valid writes.
    writeFileSync(join(root, 'README.md'), stale);
    writeFileSync(join(root, 'docs/broken.md'), '<!-- fresh:end -->');
    assert.throws(() => synchronize(root), /docs\/broken.md/);
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), stale);
    writeFileSync(join(root, 'CHANGELOG.md'), '## [3.0.0] - Unreleased\n');
    assert.equal(run('check.mjs').status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('renders all blocks together and leaves unmarked historical pins intact', () => {
  const names = ['version-badge', 'install-snippet', 'version-table', 'example-version-pin'];
  const text = names.map((name) => `<!-- fresh:begin ${name} -->\nstale\n<!-- fresh:end -->`).join('\n') + '\nHistorical @ashlr/phantom@1.0.0\n';
  const result = regenerate(text, facts);
  assert.ok(!result.includes('stale'));
  assert.ok(result.endsWith('Historical @ashlr/phantom@1.0.0\n'));
  assert.equal(regenerate(result, facts), result);
});
