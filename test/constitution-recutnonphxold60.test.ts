import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('checks rule references through the CLI and reports missing IDs', () => {
  const root = mkdtempSync(join(tmpdir(), 'constitution-recut-'));
  try {
    mkdirSync(join(root, 'prompts'));
    writeFileSync(join(root, 'CONSTITUTION.md'), '## RULE-1 Evidence\n');
    writeFileSync(join(root, 'prompts', 'task.md'), 'Use RULE-1 and RULE-2.\n');
    const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'),
      'constitution', 'check', '--root', root, '--json'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, ruleCount: 1, referenceCount: 2,
      diagnostics: [{ path: 'prompts/task.md', line: 1, id: 'RULE-2', kind: 'missing' }] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
