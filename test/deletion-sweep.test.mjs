import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixtures = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deletion-sweep-'));
  fixtures.push(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.agent'));
  writeFileSync(join(root, '.agent', 'agent-rules.txt'), 'Hidden old rule [last-used: 2020-01-01] [outcome: failure]\n');
  writeFileSync(join(root, 'src', 'example.ts'), 'export function unusedThing() { return 1; }\nexport function usedThing() { return 2; }\nusedThing();\nfunction unusedRoutine() {}\n');
  writeFileSync(join(root, 'ENGINEER-RULES.md'), '- Retire old instruction [last-used: 2020-01-01] [outcome: failure]\n- Keep successful rule [last-used: 2020-01-01] [outcome: success]\n- Unknown rule\n');
  writeFileSync(join(root, 'agent-rules.txt'), 'Plain old rule [last-used: 2020-01-01] [outcome: failure]\n');
  writeFileSync(join(root, 'router-queue.md'), '## Old prompt [last-used: 2020-01-01] [outcome: failure]\n');
  return root;
}
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

function run(args) {
  return spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), ...args], { encoding: 'utf8', timeout: 30000 });
}

describe('deletion sweep', () => {
  it('reports unused code and stale rules, while preserving every input', () => {
    const root = fixture();
    const original = readFileSync(join(root, 'src', 'example.ts'), 'utf8');
    const result = run(['sweep', 'report', '--repo', root]);
    assert.equal(result.status, 0, result.stderr);
    const report = readFileSync(join(root, 'reports', 'deletion-sweep.md'), 'utf8');
    assert.match(report, /Review removal \| export \| src\/example\.ts:1 \| unusedThing/);
    assert.match(report, /Keep \/ investigate \| export \| src\/example\.ts:2 \| usedThing/);
    assert.match(report, /Review removal \| routine \| src\/example\.ts:4 \| unusedRoutine/);
    assert.match(report, /Review removal \| rule \| ENGINEER-RULES\.md:1 \| - Retire old instruction/);
    assert.match(report, /Keep \/ investigate \| rule \| ENGINEER-RULES\.md:2 \| - Keep successful rule/);
    assert.match(report, /Keep \/ investigate \| rule \| ENGINEER-RULES\.md:3 \| - Unknown rule/);
    assert.match(report, /Review removal \| rule \| agent-rules\.txt:1 \| Plain old rule/);
    assert.match(report, /Review removal \| rule \| \.agent\/agent-rules\.txt:1 \| Hidden old rule/);
    assert.match(report, /Review removal \| prompt \| router-queue\.md:1/);
    assert.match(report, /Git history: unavailable/);
    assert.equal(readFileSync(join(root, 'src', 'example.ts'), 'utf8'), original);
    assert.equal(run(['sweep', 'report', '--repo', root]).status, 0);
    assert.match(readFileSync(join(root, 'reports', 'deletion-sweep.md'), 'utf8'), /Weekly deletion sweep/);
  });

  it('uses recent Git activity as a separate score signal and truncates an older report', () => {
    const root = fixture();
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    assert.equal(git('add', 'src/example.ts', 'ENGINEER-RULES.md', 'agent-rules.txt', 'router-queue.md').status, 0);
    assert.equal(git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture').status, 0);
    mkdirSync(join(root, 'reports'));
    writeFileSync(join(root, 'reports', 'deletion-sweep.md'), 'x'.repeat(100000));
    const result = run(['sweep', 'report', '--repo', root]);
    assert.equal(result.status, 0, result.stderr);
    const report = readFileSync(join(root, 'reports', 'deletion-sweep.md'), 'utf8');
    assert.match(report, /Git history: available/);
    assert.match(report, /unusedThing \| 25\/100 \| 0 identifier references \| unknown \| \d{4}-\d\d-\d\d/);
    assert.match(report, /usedThing \| 75\/100 \| 1 identifier references \| unknown/);
    assert.doesNotMatch(report, /x{100}/);
  });

  it('refuses a symlinked report instead of writing outside the report', () => {
    const root = fixture();
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'untouched');
    mkdirSync(join(root, 'reports'));
    symlinkSync(outside, join(root, 'reports', 'deletion-sweep.md'));
    const result = run(['sweep', 'report', '--repo', root]);
    assert.equal(result.status, 1);
    assert.equal(readFileSync(outside, 'utf8'), 'untouched');
  });

  it('validates arguments and offers help without creating a report', () => {
    const root = fixture();
    assert.equal(run(['sweep', '--help']).status, 0);
    assert.equal(run(['sweep', 'report', '-h']).status, 0);
    assert.equal(run(['sweep', 'report', '--repo', root, '--delete']).status, 2);
    assert.throws(() => readFileSync(join(root, 'reports', 'deletion-sweep.md')));
  });
});
