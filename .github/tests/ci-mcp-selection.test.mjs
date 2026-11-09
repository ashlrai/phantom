import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCP_INVENTORY_PATHS, selectMcpOutputTest } from '../scripts/ci-mcp-selection.mjs';

test('native inventory and registry changes select the output contract test', () => {
  for (const path of MCP_INVENTORY_PATHS) assert.equal(selectMcpOutputTest([path]), true, path);
  assert.equal(selectMcpOutputTest(['src/core/unrelated.ts']), false);
  assert.equal(selectMcpOutputTest([]), false);
});

test('Git diff selects additions, deletions and renames and rejects bad identities', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { selectMcpDiff } = await import('../scripts/ci-mcp-selection.mjs');
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-selection-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'CI');
    git('config', 'user.email', 'ci@example.invalid');
    mkdirSync(join(cwd, 'src/core'), { recursive: true });
    writeFileSync(join(cwd, 'src/core/mcp-native.ts'), 'inventory\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    renameSync(join(cwd, 'src/core/mcp-native.ts'), join(cwd, 'src/core/renamed.ts'));
    git('add', '-A'); git('commit', '-qm', 'rename');
    const head = git('rev-parse', 'HEAD');
    assert.equal(selectMcpDiff({ cwd, base, head }), true);
    assert.throws(() => selectMcpDiff({ cwd, base: 'bad', head }), /exact commit SHAs/);
    assert.throws(() => selectMcpDiff({ cwd, base, head: base }), /checkout does not match/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
