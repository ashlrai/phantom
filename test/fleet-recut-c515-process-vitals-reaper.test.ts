import { expect, it, vi } from 'vitest';
import { readProcessVitals, type ProcessVitalsIo } from '../src/core/fleet/process-vitals.js';

// Recut of #6456: orphan-root reaper guards, exercised through readProcessVitals.
const date = 'Mon Nov 16 12:00:00 2026';
const now = Date.parse(date) + 180_000;
const boot = '12345678-1234-1234-1234-123456789abc';
const start = Math.floor(Date.parse(date) / 1000).toString(16).padStart(64, '0');
const row = (pid: number, ppid: number, exe: string) => `${pid} ${ppid} 501 1.5 2048 ${date} ${exe}`;

function setup(rows: string[], jobs: Record<number, string>) {
  const files = new Map<string, string>();
  const ledger: string[] = [];
  for (const [pid, id] of Object.entries(jobs)) {
    ledger.push(JSON.stringify({ job: id, event: 'outcome', state: 'MERGED', ts: new Date(now - 120_000).toISOString() }));
    files.set(`/runs/queue/run/resource-sessions/${id}.json`, JSON.stringify({ schemaVersion: 1, jobId: id, rootPid: Number(pid), startSource: 'ps-lstart', start, bootId: boot, ownerWitness: 'b'.repeat(64) }));
  }
  files.set('/runs/metrics/jobs.jsonl', ledger.join('\n'));
  const lsof = Object.entries(jobs).map(([pid, id]) => `p${pid}\nn/fake-home/Projects/ashlrai/wt/${id}`).join('\n');
  const out: Record<string, string> = { '/bin/ps': rows.join('\n'), '/usr/sbin/lsof': lsof, '/bin/launchctl': '99 0 ai.ashlr.daemon', '/usr/sbin/sysctl': boot };
  const run = vi.fn(async (file: string, _args: string[]) => out[file] ?? null);
  const io: ProcessVitalsIo = { home: '/fake-home', uid: 501, now: () => now, run, read: f => files.get(f) ?? null, signal: vi.fn() };
  return { io, run };
}

it('previews orphan roots without signalling, then signals each verified root individually', async () => {
  const { io, run } = setup([row(20, 1, '/usr/bin/node'), row(21, 20, '/usr/bin/node'), row(30, 1, '/bin/bash')], { 20: 'RQ-ONE', 30: 'RQ-TWO' });
  const preview = await readProcessVitals('/runs', undefined, io);
  expect(preview.reaper.candidates).toEqual([{ pid: 20, job: 'RQ-ONE' }, { pid: 30, job: 'RQ-TWO' }]);
  expect(preview.reaper.plan).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(io.signal).not.toHaveBeenCalled();
  // Census never asks ps for argv or environment.
  const psArgs = run.mock.calls.find(c => c[0] === '/bin/ps')![1].join(' ');
  expect(psArgs).not.toMatch(/\bargs\b|\bcommand\b|\benv/);

  const applied = await readProcessVitals('/runs', preview.reaper.plan, io);
  expect(applied.reaper.signalled).toEqual([20, 30]);
  expect(vi.mocked(io.signal).mock.calls).toEqual([[20], [30]]); // positive pids only, never a group
});

it('refuses a stale plan digest and signals nothing', async () => {
  const { io } = setup([row(20, 1, '/usr/bin/node')], { 20: 'RQ-ONE' });
  await expect(readProcessVitals('/runs', `sha256:${'0'.repeat(64)}`, io)).rejects.toThrow('plan changed');
  expect(io.signal).not.toHaveBeenCalled();
});

it('reports a failed signal as skipped rather than signalled', async () => {
  const { io } = setup([row(20, 1, '/usr/bin/node')], { 20: 'RQ-ONE' });
  const plan = (await readProcessVitals('/runs', undefined, io)).reaper.plan;
  vi.mocked(io.signal).mockImplementation(() => { throw new Error('ESRCH'); });
  const r = await readProcessVitals('/runs', plan, io);
  expect(r.reaper).toMatchObject({ signalled: [], skipped: [20] });
});
