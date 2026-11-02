import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphArgvRun } from '../src/core/fleet/graph-argv-run.js';
const dir = mkdtempSync(join(tmpdir(), 'graph-run-'));
const previous = process.env.ASHLR_RUNS_DIR;
process.env.ASHLR_RUNS_DIR = dir;
afterEach(() => { rmSync(join(dir, 'ORCH_OFF'), { force: true }); });
const argv = (code: string): string[] => [process.execPath, '-e', code];
const marker = join(dir, 'marker');
const touch = argv(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ok')`);
async function run(tasks: unknown[], apply = true, timeout = 2000) {
  const file = join(dir, 'graph.json');
  writeFileSync(file, JSON.stringify({ version: 1, tasks }));
  return graphArgvRun(file, apply, timeout);
}
it('success unlocks B', async () => {
  const r = await run([{ id: 'A', argv: argv('process.exit(0)') }, { id: 'B', dependsOn: ['A'], argv: touch }]);
  expect(r.nodes.map(n => n.status)).toEqual(['success', 'success']);
  expect(existsSync(marker)).toBe(true); rmSync(marker);
});
it('failure blocks descendants while independent work runs', async () => {
  const r = await run([{ id: 'A', argv: argv('process.exit(7)') }, { id: 'B', dependsOn: ['A'], argv: touch }, { id: 'C', argv: argv('') }]);
  expect(r.nodes.find(n => n.id === 'B')?.status).toBe('blocked');
  expect(r.nodes.find(n => n.id === 'C')?.status).toBe('success');
  expect(r.nodes[0].exitCode).toBe(7);
});
it('preview and invalid late nodes launch nothing', async () => {
  expect((await run([{ id: 'A', argv: touch }], false)).status).toBe('preview');
  expect((await run([{ id: 'A', argv: touch }, { id: 'B', argv: [] }])).status).toBe('invalid');
  expect(existsSync(marker)).toBe(false);
});
it('refuses ORCH_OFF', async () => {
  writeFileSync(join(dir, 'ORCH_OFF'), '');
  expect((await run([{ id: 'A', argv: touch }])).nodes[0].status).toBe('refused');
  expect(existsSync(marker)).toBe(false);
});
it('times out and reaps a child', async () => {
  expect((await run([{ id: 'A', argv: argv('setInterval(()=>{},1000)') }], true, 50)).nodes[0].status).toBe('timeout');
});
it('cancellation prevents subsequent starts and removes listeners', async () => {
  const before = process.listenerCount('SIGINT');
  const timer = setTimeout(() => process.emit('SIGINT'), 100);
  const r = await run([{ id: 'A', argv: argv('setInterval(()=>{},1000)') }, { id: 'B', argv: touch }]);
  clearTimeout(timer);
  expect(r.nodes.map(n => n.status)).toEqual(['cancelled', 'cancelled']);
  expect(process.listenerCount('SIGINT')).toBe(before);
  expect(existsSync(marker)).toBe(false);
  if (previous === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = previous;
  rmSync(dir, { recursive: true });
});
