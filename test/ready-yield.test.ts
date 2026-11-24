import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { orderReadyByYield, orderReadyFile } from '../src/core/fleet/ready-yield.js';
import { cmdJobs } from '../src/cli/jobs-empty.js';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { SELF_TICK_STEP_ORDER } from '../src/core/fleet/self-tick.js';

vi.mock('../src/cli/fleet-planner-tick.js', () => ({ cmdFleetPlannerTick: async (_args: string[], io: { output: (text: string) => void }) => { io.output('{"outcome":"plain"}'); return 0; } }));
let root: string;
const now = Date.UTC(2026, 10, 21), row = (id: string) => `${id}\tplain\tplain\twork\t/plain\textra`;
const stats = [{ family: 'recut', launches: 14, merged: 1, prs: 1 }, { family: 'finish', launches: 4, merged: 4, prs: 4 }];
const lock = async () => ({ quiet: true, release: vi.fn(async () => {}) });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'order-')); await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const text = `# plain\r\n${row('recut-20')}\r\n\n${row('fresh')}\n${row('finish-20')}`;
  await writeFile(join(root, 'queue/ready.tsv'), text);
  const lines = stats.flatMap(s => Array.from({ length: s.launches }, (_, i) => {
    const job = `${s.family}-${i}`, ts = new Date(now - 1000).toISOString();
    return [JSON.stringify({ job, ts, event: 'launch' }), ...(i < s.prs ? [JSON.stringify({ job, ts, event: 'publish', class: 'pr', pr: i + 1, outcome: 'MERGED' })] : [])];
  }).flat());
  lines.unshift(JSON.stringify({ job: 'fresh', event: 'launch', ts: new Date(now - 25 * 3600000).toISOString() }));
  await writeFile(join(root, 'metrics/jobs.jsonl'), lines.join('\n')); return text;
}
it('orders measured yield around the neutral prior, preserves ties and leaves input untouched', () => {
  const rows = ['recut', 'fresh', 'finish', 'new'].map(id => ({ id }));
  expect(orderReadyByYield(rows, stats).map(r => r.id)).toEqual(['finish', 'fresh', 'new', 'recut']);
  expect(orderReadyByYield([{ id: 'fresh' }, { id: 'FINISH5S' }], [{ family: 'FINISH', launches: 4, merged: 4, prs: 4 }]).map(r => r.id)).toEqual(['FINISH5S', 'fresh']);
  expect(rows.map(r => r.id)).toEqual(['recut', 'fresh', 'finish', 'new']);
  expect(orderReadyByYield(rows, stats.map(s => ({ ...s, merged: 0 })))[0]?.id).toBe('fresh');
  expect(orderReadyByYield(rows, stats.map(s => ({ ...s, merged: 0, prs: s.family === 'recut' ? 14 : 1 }))).at(-1)?.id).toBe('finish');
});
it('keeps fixes and incidents first in their original order', () => {
  const ids = ['recut', 'RQ-FIXUP-CI', 'finish', 'RQ-INCIDENT', 'RQ-FIXUP-MAIN'];
  expect(orderReadyByYield(ids.map(id => ({ id })), stats).map(r => r.id)).toEqual([ids[1], ids[3], ids[4], 'finish', 'recut']);
});
it('previews without writes, then preserves row bytes, comments, blanks and final newline state', async () => {
  const text = await fixture(), path = join(root, 'queue/ready.tsv');
  const preview = await orderReadyFile(root, false, now);
  expect(preview.rows.map(r => r.id)).toEqual(['finish-20', 'fresh', 'recut-20']); expect(preview.moved).toBe(2);
  expect(await readFile(path, 'utf8')).toBe(text);
  expect(await orderReadyFile(root, true, now, { lock })).toMatchObject({ applied: true, moved: 2 });
  expect(await readFile(path, 'utf8')).toBe(`# plain\r\n${row('finish-20')}\n\n${row('fresh')}\n${row('recut-20')}\r`);
  expect((await orderReadyFile(root, true, now, { lock })).moved).toBe(0);
});
it('leaves the original complete file on rename failure and removes the temporary file', async () => {
  const text = await fixture();
  await expect(orderReadyFile(root, true, now, { lock, rename: async temp => {
    expect(await readFile(temp, 'utf8')).toContain(row('finish-20')); throw new Error('plain');
  } })).rejects.toThrow('plain');
  expect(await readFile(join(root, 'queue/ready.tsv'), 'utf8')).toBe(text);
  expect(await readdir(join(root, 'queue'))).toEqual(['ready.tsv']);
});
it('refuses an active dispatcher tick and releases its lock', async () => {
  const text = await fixture(), release = vi.fn(async () => {});
  await expect(orderReadyFile(root, true, now, { lock: async () => ({ quiet: false, release }) })).rejects.toThrow('tick active');
  expect(release).toHaveBeenCalledOnce(); expect(await readFile(join(root, 'queue/ready.tsv'), 'utf8')).toBe(text);
});
it('routes the CLI, exposes unknown metrics and rejects bad arguments', async () => {
  await writeFile(join(root, 'queue/ready.tsv'), row('fresh'));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdJobs(['order', '--json', '--runs-dir', root])).toBe(0);
  expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ known: false, applied: false, rows: [{ id: 'fresh', yield: 0.5, reason: 'new: prior 0.5' }] });
  vi.spyOn(console, 'error').mockImplementation(() => {}); expect(await cmdJobs(['order', '--bad'])).toBe(2);
});
it.each([false, true])('runs ordering exactly once inside self-tick, applying only with apply=%s', async apply => {
  await fixture(); const order = vi.fn(orderReadyFile), output: string[] = [];
  const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.filter(s => s !== 'planner-tick').map(s => [s, async () => ({ exitCode: 0, output: '{}' })]));
  expect(await cmdFleetSelfTick(['--runs-dir', root, ...(apply ? ['--apply'] : [])], { now: () => now, steps, orderReady: order, output: text => output.push(text) })).toBe(0);
  expect(order).toHaveBeenCalledExactlyOnceWith(root, apply, now);
  expect(output.join('\n')).toContain(`order: ${apply ? 'moved' : 'would move'} 2 rows, top finish-20 yield 1.00`);
});
