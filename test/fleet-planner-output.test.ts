import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cmdFleetPlannerOutput } from '../src/cli/fleet-planner-output.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function run(args: string[], home?: string) {
  let output = '';
  const code = await cmdFleetPlannerOutput(args, { home, now: () => Date.parse('2026-01-02T00:00:00Z'), stdout: { write(text) { output += text; } } });
  return { code, output };
}
it('rejects malformed, repeated and missing flags and invalid windows', async () => {
  for (const args of [[], ['--since'], ['--since', 'yesterday'], ['--since', '2026-01-01T00:00:00'],
    ['--since', '2026-01-01T00:00:00Z', '--since', '2026-01-01T00:00:00Z'],
    ['--since', '2026-01-01T00:00:00Z', '--until', '2025-01-01T00:00:00Z'],
    ['--since', '2026-01-01T00:00:00Z', '--runs-dir', 'relative'], ['--unknown']]) {
    expect((await run(args)).code).toBe(2);
  }
});
it('prints JSON and human-readable lists with exit zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pass-cli-')); roots.push(root);
  const dir = join(root, 'leader', 'drop', 'claude'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'RQ-PHX-ABC.md'), 'fixture');
  const args = ['--since', '2000-01-01T00:00:00Z', '--until', '2100-01-01T00:00:00Z', '--runs-dir', root];
  const human = await run(args, root);
  expect(human.code).toBe(0);
  expect(human.output).toContain('Pass wrote 1 jobs: 0 ingested, 1 pending, 0 rejected\n');
  expect(human.output).toContain('Pending: RQ-PHX-ABC\n');
  const json = await run([...args, '--json'], root);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.output)).toMatchObject({ v: 1, counts: { ingested: 0, pending: 1, rejected: 0 }, sources: { ledger: 'missing' } });
});
