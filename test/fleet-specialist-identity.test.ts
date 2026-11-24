import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assignSpecialist, configureSpecialistIdentity, loadSpecialistRoster, saveSpecialistRoster,
  specialistForPeer, SPECIALIST_ROSTER_SCHEMA } from '../src/core/fleet/roster.js';
import { buildSpecialistIdentity, loadSpecialistIdentity } from '../src/core/fleet/specialist-identity.js';
import { cmdFleetRoster } from '../src/cli/fleet-roster.js';
import type { OrchestrationJournal } from '../src/core/fleet/orchestration-journal.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const metadata = { role: 'reviewer', capabilityTags: ['typescript'], machineAffinity: ['mac-1'], laneAffinity: ['codex'], peerIds: ['agentnet:dot'] };
const roster = () => assignSpecialist({ schema: SPECIALIST_ROSTER_SCHEMA, specialists: [] }, 'dot', 'fleet');
const at = '2026-11-15T12:00:00Z', later = '2026-11-15T13:00:00Z';
const now = Date.parse('2026-11-16T00:00:00Z');
const receipt = (job: string, specialist = 'dot') => ({ key: 'a'.repeat(64), job, specialist, lane: 'codex', assignedAt: at, status: 'admitted' as const });
const journal = (...jobs: string[]): OrchestrationJournal => ({ version: 1, receipts: jobs.map(job => receipt(job)) });
const event = (job: string, kind: string, extra = {}) => ({ job, event: kind, ts: later, lane: 'codex', ...extra });

it('persists identity through configuration, reload and reassignment without changing legacy snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-')); roots.push(directory);
  const old = roster();
  await saveSpecialistRoster(old, directory);
  expect(await loadSpecialistRoster(directory)).toEqual(old);
  const configured = configureSpecialistIdentity(old, 'dot', metadata);
  await saveSpecialistRoster(configured, directory);
  expect(assignSpecialist(await loadSpecialistRoster(directory), 'dot', 'reviews').specialists[0]!.identity).toEqual(metadata);
  expect(old.specialists[0]!.identity).toBeUndefined();
  expect(specialistForPeer(configured, 'agentnet:dot')?.id).toBe('dot');
  expect(specialistForPeer(configured, 'unknown')).toBeNull();
  const two = assignSpecialist(configured, 'instinct', 'build');
  expect(() => configureSpecialistIdentity(two, 'instinct', metadata)).toThrow();
  expect(() => configureSpecialistIdentity(old, 'missing', metadata)).toThrow();
  expect(() => configureSpecialistIdentity(old, 'dot', { ...metadata, peerIds: ['../bad'] })).toThrow();
  expect(() => configureSpecialistIdentity(old, 'dot', { ...metadata, capabilityTags: 'bad' as never })).toThrow();
});

it('aggregates real jobs.jsonl fixture records idempotently and ignores legacy reputation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-')); roots.push(directory);
  const state = roster(); state.specialists[0]!.stats = { jobs: 500, merges: 500, reverts: 0, emptyRate: 0 };
  await saveSpecialistRoster(state, directory);
  await writeFile(join(directory, 'orchestration.json'), JSON.stringify(journal('J1', 'J2', 'J3')));
  const records = [event('J1', 'launch'), event('J1', 'finish', { empty: false }),
    event('J1', 'outcome', { state: 'MERGED' }), event('J1', 'outcome', { state: 'MERGED' }),
    event('J1', 'revert'), event('J2', 'finish', { empty: true, outcome: 'FAILED' }),
    event('J3', 'launch'), event('unassigned', 'outcome', { state: 'MERGED' })];
  const jobsPath = join(directory, 'jobs.jsonl');
  await writeFile(jobsPath, records.map(row => JSON.stringify(row)).join('\n'));
  const before = await readFile(join(directory, 'roster.json'), 'utf8');
  const result = await loadSpecialistIdentity('dot', directory, jobsPath, now);
  expect(result.outcomes).toMatchObject({ sourceState: 'healthy', jobs: 3, finished: 2, merges: 1, reverts: 1,
    failed: 1, empty: 1, emptySamples: 2, emptyRate: 0.5 });
  expect(result.specialist).not.toHaveProperty('stats');
  expect(await readFile(join(directory, 'roster.json'), 'utf8')).toBe(before);
});

it('reports unknown history without creating files, and labels malformed evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-')); roots.push(directory);
  await saveSpecialistRoster(roster(), directory);
  const path = join(directory, 'jobs.jsonl');
  const missing = await loadSpecialistIdentity('dot', directory, path, now);
  expect(missing.outcomes).toMatchObject({ jobs: 0, merges: 0, sourceState: 'missing', emptyRate: null });
  expect(missing.evidence.assignments).toBe('missing');
  expect(await readdir(directory)).toEqual(['roster.json']);
  await writeFile(path, '{}\nmalformed\n');
  await writeFile(join(directory, 'orchestration.json'), JSON.stringify(journal()));
  expect((await loadSpecialistIdentity('dot', directory, path, now)).outcomes.sourceState).toBe('degraded');
  await symlink(path, join(directory, 'linked.jsonl'));
  expect((await loadSpecialistIdentity('dot', directory, join(directory, 'linked.jsonl'), now)).outcomes.sourceState).toBe('degraded');
  await writeFile(join(directory, 'orchestration.json'), 'bad');
  await expect(loadSpecialistIdentity('dot', directory, path, now)).rejects.toThrow();
});

it('uses lane-less outcome rows only when one assignment pair is proven', () => {
  const assignments = journal('J1');
  const merge = { job_id: 'J1', event: 'outcome', timestamp: later, outcome: 'MERGED' };
  expect(buildSpecialistIdentity(roster(), 'dot', assignments, [merge], now).outcomes.merges).toBe(1);
  assignments.receipts.push({ ...receipt('J1'), lane: 'claude' });
  expect(buildSpecialistIdentity(roster(), 'dot', assignments, [merge], now).outcomes).toMatchObject({ merges: 0, ambiguousRows: 1 });
});

it('rejects ambiguous attribution, reserved assignments, future and pre-assignment events', () => {
  const assignments = journal('ambiguous', 'reserved', 'early', 'future', 'conflict', 'empty');
  assignments.receipts.push(receipt('ambiguous', 'instinct'));
  assignments.receipts[1]!.status = 'reserved';
  const events = [event('ambiguous', 'finish'), event('reserved', 'finish'),
    event('early', 'finish', { ts: '2026-11-14T00:00:00Z' }),
    event('future', 'finish', { ts: '2027-01-01T00:00:00Z' }),
    event('conflict', 'finish', { specialist: 'instinct' }),
    event('empty', 'finish', { empty: true }), event('empty', 'finish', { empty: false })];
  const result = buildSpecialistIdentity(roster(), 'dot', assignments, events, now);
  expect(result.outcomes).toMatchObject({ jobs: 1, emptySamples: 0, emptyRate: null, ambiguousRows: 2, ignoredRows: 1, sourceState: 'degraded' });
  expect(result.authority).toEqual({ coordinationOnly: true, execution: false, sends: false });
});

it('provides configure and identity CLI commands while retaining show output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-')); roots.push(directory);
  await saveSpecialistRoster(roster(), directory);
  const output: string[] = [];
  const deps = { directory, jobsPath: join(directory, 'missing'), out: (s: string) => output.push(s), err: () => undefined };
  expect(await cmdFleetRoster(['configure', 'dot', JSON.stringify(metadata), '--json'], deps)).toBe(0);
  expect(await cmdFleetRoster(['show', 'dot', '--json'], deps)).toBe(0);
  expect(JSON.parse(output.pop()!).specialist.stats.jobs).toBe(0);
  expect(await cmdFleetRoster(['identity', 'dot', '--json'], deps)).toBe(0);
  expect(JSON.parse(output.pop()!).schema).toBe('fleet.specialist-identity.v1');
  expect(await cmdFleetRoster(['configure', 'dot', '{}', '--json'], deps)).toBe(1);
  expect(await cmdFleetRoster(['identity', 'missing', '--json'], deps)).toBe(1);
});
