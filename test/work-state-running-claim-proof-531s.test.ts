import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetWorkState } from '../src/cli/fleet-work-state.js';
import { classifyWorkItem, type WorkItemEvidence } from '../src/core/comms/work-item-state.js';

const now = '2026-11-13T12:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
const running = { source: 'fake-heartbeat', at: now };
const base: WorkItemEvidence = { id: 'FAKE-1', receivedAt: at(-60), runningEvidence: running };
const assignment = { owner: 'fake-owner', claimReceipt: 'fake-claim' };
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('requires both nonblank assignment fields even with fresh running evidence', () => {
  for (const [fields, missing] of [
    [{}, ['named owner', 'durable claim receipt']],
    [{ owner: 'fake-owner' }, ['durable claim receipt']],
    [{ claimReceipt: 'fake-claim' }, ['named owner']],
    [{ owner: '  ', claimReceipt: '\t' }, ['named owner', 'durable claim receipt']],
    [{ owner: 'fake-owner', claimReceipt: ' ' }, ['durable claim receipt']],
    [{ owner: ' ', claimReceipt: 'fake-claim' }, ['named owner']],
  ] as const) {
    expect(classifyWorkItem({ ...base, ...fields }, now)).toMatchObject({ state: 'RECEIVED', missing });
  }
  expect(classifyWorkItem({ ...base, ...assignment }, now)).toEqual({ state: 'RUNNING', asOf: now, source: 'fake-heartbeat', missing: [] });
});

it('preserves freshness boundaries and higher priority evidence', () => {
  for (const minutes of [-30, 5]) {
    expect(classifyWorkItem({ ...base, ...assignment, runningEvidence: { ...running, at: at(minutes) } }, now).state).toBe('RUNNING');
  }
  for (const minutes of [-31, 6]) {
    expect(classifyWorkItem({ ...base, ...assignment, runningEvidence: { ...running, at: at(minutes) } }, now)).toMatchObject({ state: 'ASSIGNED', missing: ['fresh running evidence'] });
  }
  const blocker = { dependency: 'fake-dependency', source: 'fake-ledger', at: now };
  expect(classifyWorkItem({ ...base, blocker }, now).state).toBe('BLOCKED');
  for (const evidence of [{ tests: 'passed' }, { artifact: 'fake-artifact' }, { pr: 1, head: 'fake-head' }]) {
    expect(classifyWorkItem({ ...base, blocker, verified: { ...evidence, source: 'fake-source', at: now } }, now).state).toBe('VERIFIED');
  }
});

it('prints receipt-backed states through the public CLI in JSON and text', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  const root = await mkdtemp(join(tmpdir(), 'work-state-proof-'));
  roots.push(root);
  const file = join(root, 'evidence.json');
  await writeFile(file, JSON.stringify([base, { ...base, id: 'FAKE-2', ...assignment }]));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetWorkState(['--evidence', file, '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual([
    { id: 'FAKE-1', state: 'RECEIVED', asOf: at(-60), source: 'receivedAt', missing: ['named owner', 'durable claim receipt'] },
    { id: 'FAKE-2', state: 'RUNNING', asOf: now, source: 'fake-heartbeat', missing: [] },
  ]);
  log.mockClear();
  expect(await cmdFleetWorkState(['--evidence', file])).toBe(0);
  expect(log.mock.calls.map(call => call[0])).toEqual([
    `FAKE-1 RECEIVED as-of=${at(-60)} source=receivedAt missing=named owner,durable claim receipt`,
    `FAKE-2 RUNNING as-of=${now} source=fake-heartbeat missing=none`,
  ]);
});
