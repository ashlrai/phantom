import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetMergeStatus } from '../src/cli/fleet-merge-status.js';

afterEach(() => vi.restoreAllMocks());

it('reports measured and unknown queue evidence without writing a recut', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merge-status-754s-'));
  const path = join(dir, 'snapshot.json');
  const snapshot = JSON.stringify({ repo: 'example/repo', prs: [
    { number: 1, state: 'OPEN', mergeable: 'CONFLICTING', headSha: 'a'.repeat(40) },
    { number: 2, state: 'OPEN' },
    { number: 3, state: 'CLOSED' },
  ], queue: [
    { number: 1, enteredAt: '2026-11-03T10:00:00Z', requiredChecks: [{ name: 'Gate', status: 'failure', at: '2026-11-03T11:00:00Z' }] },
    { number: 2 }, { number: 3 },
  ] });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-03T12:00:00Z'));
  try {
    await writeFile(path, snapshot);
    expect(await cmdFleetMergeStatus(['--input', path])).toBe(0);
    const output = log.mock.calls.map(call => String(call[0])).join('\n');
    expect(output).toContain('#1\t2h 0m 0s queued');
    expect(output).toContain('#2\tunknown age');
    expect(output).not.toContain('#3');
    expect(output).toMatch(/conflict/i);
    expect(output).toMatch(/Gate/);
    expect(await readFile(path, 'utf8')).toBe(snapshot);
    expect(await readdir(dir)).toEqual(['snapshot.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('rejects invalid arguments and snapshots and explains read-only help', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merge-status-invalid-754s-'));
  const path = join(dir, 'snapshot.json');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await cmdFleetMergeStatus(['--help'])).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/does not enqueue/);
    expect(await cmdFleetMergeStatus(['--input'])).toBe(2);
    await writeFile(path, JSON.stringify({ prs: [], queue: [{ number: 1, requiredChecks: [{ name: 'Gate', status: 'invalid' }] }] }));
    expect(await cmdFleetMergeStatus(['--input', path])).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
