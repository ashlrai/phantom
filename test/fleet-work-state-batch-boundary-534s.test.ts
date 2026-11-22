import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetWorkState } from '../src/cli/fleet-work-state.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function runEvidence(contents: string, json: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'work-state-batch-'));
  roots.push(root);
  const file = join(root, 'evidence.json');
  await writeFile(file, contents);
  await writeFile(join(root, 'sentinel.txt'), 'synthetic sentinel\n');
  const snapshot = async () => Promise.all((await readdir(root)).sort().map(async name => [name, (await readFile(join(root, name))).toString('hex')]));
  const before = await snapshot();
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdFleetWorkState(['--evidence', file, ...(json ? ['--json'] : [])]);
  expect(await snapshot()).toEqual(before);
  return { code, out, err };
}

it.each([false, true])('rejects a malformed later item atomically (json=%s)', async json => {
  const result = await runEvidence(JSON.stringify([
    { id: 'SYNTHETIC-FIRST', receivedAt: '2026-11-12T22:29:00Z' },
    { id: 'SYNTHETIC-SECOND', verified: { source: 'test', at: '2026-11-12T22:30:00Z', pr: '42' } },
  ]), json);
  expect(result.code).toBe(2);
  expect(result.out).not.toHaveBeenCalled();
  expect(result.err).toHaveBeenCalledOnce();
  expect(String(result.err.mock.calls[0]?.[0])).toMatch(/item 1.*verified\.pr/i);
});

it.each([false, true])('reports malformed shapes and JSON without output (json=%s)', async json => {
  const cases: [string, RegExp][] = [
    ['null', /evidence.*object/i],
    [JSON.stringify([[]]), /item 0.*object/i],
    [JSON.stringify({ id: 'x', blocker: [] }), /blocker.*object/i],
    [JSON.stringify({ id: 'x', runningEvidence: null }), /runningEvidence.*object/i],
    [JSON.stringify({ id: 'x', verified: 'done' }), /verified.*object/i],
    [JSON.stringify({ id: 'x', blocker: { dependency: {} } }), /blocker\.dependency/i],
    [JSON.stringify({ id: 'x', runningEvidence: { at: [] } }), /runningEvidence\.at/i],
    [JSON.stringify({ id: 'x', verified: { tests: null } }), /verified\.tests/i],
    ['{"id":', /evidence file/i],
  ];
  for (const [contents, message] of cases) {
    const result = await runEvidence(contents, json);
    expect(result.code).toBe(2);
    expect(result.out).not.toHaveBeenCalled();
    expect(result.err).toHaveBeenCalledOnce();
    expect(String(result.err.mock.calls[0]?.[0])).toMatch(message);
    vi.restoreAllMocks();
  }
});

it('emits one ordered JSON array for a valid mixed batch', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T23:00:00Z'));
  const result = await runEvidence(JSON.stringify([
    { id: 'SYNTHETIC-RECEIVED', receivedAt: '2026-11-12T22:29:00Z' },
    { id: 'SYNTHETIC-BLOCKED', blocker: { dependency: 'fixture', source: 'test', at: '2026-11-12T22:40:00Z' } },
    { id: 'SYNTHETIC-VERIFIED', verified: { artifact: 'fake-test-report.xml', tests: 'passed', source: 'test', at: '2026-11-12T22:50:00Z' } },
  ]), true);
  expect(result.code).toBe(0);
  expect(result.err).not.toHaveBeenCalled();
  expect(result.out).toHaveBeenCalledOnce();
  const parsed = JSON.parse(String(result.out.mock.calls[0]?.[0]));
  expect(parsed.map((item: { id: string; state: string }) => [item.id, item.state])).toEqual([
    ['SYNTHETIC-RECEIVED', 'RECEIVED'],
    ['SYNTHETIC-BLOCKED', 'BLOCKED'],
    ['SYNTHETIC-VERIFIED', 'VERIFIED'],
  ]);
});
