import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetPlannerBrief } from '../src/cli/fleet-planner-brief.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it.each([['--bad'], ['--runs-dir'], ['--repo', 'relative'], ['--runs-dir', 'relative'], ['--note'], ['--json', '--json'], ['--write', '--write'], ['--note', 'a', '--note', 'b']])('rejects bad flags %j', async (...args) => {
  expect(await cmdFleetPlannerBrief(args, { stdout: { write: () => undefined } })).toBe(2);
});
it('reports missing orchestration as exit 1 and writes the private prompt with counts and path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brief-cli-')); roots.push(root);
  let output = '';
  const io = { stdout: { write: (s: string) => { output += s; } } };
  const args = ['--runs-dir', root, '--repo', root, '--json'];
  expect(await cmdFleetPlannerBrief(args, io)).toBe(1);
  expect(JSON.parse(output).missing).toContain('leader/ORCHESTRATION.md');
  await mkdir(join(root, 'leader')); await writeFile(join(root, 'leader/ORCHESTRATION.md'), '# Live');
  output = '';
  expect(await cmdFleetPlannerBrief([...args, '--write', '--note', 'tick'], io)).toBe(0);
  const report = JSON.parse(output);
  expect(report.path).toBe(join(root, 'queue/planner-brief.prompt'));
  const text = await readFile(report.path, 'utf8');
  expect(text).toContain('NOTE FROM TICK: tick'); expect(report.bytes).toBe(Buffer.byteLength(text));
  output = '';
  expect(await cmdFleetPlannerBrief(['--runs-dir', root, '--repo', root], io)).toBe(0);
  expect(output).toContain('usedIds: 0'); expect(output).toContain('missing:');
});
