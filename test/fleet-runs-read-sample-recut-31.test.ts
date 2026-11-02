import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRunsRead } from '../src/cli/fleet-runs-read.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import type { LeaderJournalV1 } from '../src/core/fleet/leader-journal.js';
import type { FleetQueueV1 } from '../src/core/fleet/runs-parked-queue.js';

const laneRow = (lane: string) => ({ lane, running: 1, target: 2, floor: null, ceiling: null,
  queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const runs: FleetRunsDirState = {
  v: 1, generatedAt: 'fake-time', runsDirPresent: true, sourceState: 'healthy',
  sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
  lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, switches: ['HOLD'], claudeLane: null,
  lanes: [laneRow('fake-a'), laneRow('fake-b'), laneRow('fake-c')],
  // claimed.tsv is append-ordered: the file's oldest rows come first.
  claimed: [
    { job: 'fake-old', lane: 'fake-a', tier: 'fake', at: '2026-10-30T01:00:00.000Z' },
    { job: 'fake-mid', lane: 'fake-b', tier: 'fake', at: '2026-10-31T02:00:00.000Z' },
    { job: 'fake-new', lane: 'fake-a', tier: 'fake', at: '2026-10-31T03:00:00.000Z' },
  ],
  publishesLastHour: [
    { job: 'fake-p2', lane: 'fake-b', url: null, at: '2026-10-31T02:00:00.000Z' },
    { job: 'fake-p1', lane: 'fake-a', url: null, at: '2026-10-31T01:00:00.000Z' },
  ],
  events: [
    { at: '2026-10-31T03:00:00Z', kind: 'LAUNCH', text: 'fake newest' },
    { at: '2026-10-31T02:00:00Z', kind: 'PUBLISHED', text: 'fake middle' },
    { at: '2026-10-31T01:00:00Z', kind: 'LANE_HOLD', text: 'fake oldest' },
  ],
  drop: { pending: [{ lane: 'fake-a', file: 'fake-1.md' }, { lane: 'fake-b', file: 'fake-2.md' }, { lane: 'fake-a', file: 'fake-3.md' }], done: 2 },
};
const journal: LeaderJournalV1 = {
  v: 1, generatedAt: 'fake-time', sources: { planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy', orchestration: 'healthy' },
  notes: [{ at: 'fake newest note', bullets: ['fake b2', 'fake b1'] }, { at: 'fake middle note', bullets: ['fake b3'] }, { at: 'fake oldest note', bullets: ['fake b4'] }],
  passes: [{ at: 'fake pass', sections: [{ title: 'fake section', bullets: ['fake bullet'] }] }],
  ingest: [{ verb: 'accept', file: 'fake-new.md', reason: null }, { verb: 'reject', file: 'fake-old.md', reason: 'fake reason' }],
  ingested: [
    { at: 'fake-new', id: 'fake-id-2', leader: 'fake', lane: 'fake-a', tier: 'fake', title: 'fake newest ingested' },
    { at: 'fake-old', id: 'fake-id-1', leader: 'fake', lane: 'fake-b', tier: 'fake', title: 'fake oldest ingested' },
  ],
  rejectedLastHour: 0,
};
const parked: FleetQueueV1 = {
  v: 1, generatedAt: 'fake-time', sources: { ready: 'healthy', skips: 'healthy' },
  total: 3, ready: 1, parked: 2, malformed: 0, skipsLast24h: 3,
  byLane: [{ lane: 'fake-a', ready: 1, parked: 0 }, { lane: 'fake-b', ready: 0, parked: 2 }],
  nextUp: [{ lane: 'fake-b', jobs: ['fake-1', 'fake-2'] }],
  groups: [{ reason: 'HOLD', lane: 'fake-b', count: 2, jobs: ['fake-1', 'fake-2'] }],
  skips: [
    { at: '2026-10-31T03:00:00+00:00', job: 'fake-new', code: 'fake', reason: 'fake newest skip' },
    { at: '2026-10-31T02:00:00+00:00', job: 'fake-mid', code: 'fake', reason: 'fake middle skip' },
    { at: '2026-10-31T01:00:00+00:00', job: 'fake-old', code: 'fake', reason: 'fake oldest skip' },
  ],
};
const readers = () => ({ runs: vi.fn(async () => structuredClone(runs)), journal: vi.fn(async () => structuredClone(journal)), parked: vi.fn(async () => structuredClone(parked)) });
let output: string[];
let errors: string;
beforeEach(() => {
  output = []; errors = '';
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors += String(chunk); return true; });
});
afterEach(() => vi.restoreAllMocks());

describe('phm fleet <verb> --sample', () => {
  it.each(['runs', 'journal', 'parked'] as const)('%s emits the newest n rows of each collection, newest first', async verb => {
    const deps = readers();
    expect(await cmdFleetRunsRead(verb, ['--json', '--sample', '2'], deps)).toBe(0);
    expect(deps[verb]).toHaveBeenCalledOnce();
    const body = JSON.parse(output.join(''));
    expect(body.sampled).toBe(2);
    expect(body.truncated).toBe(true);
    if (verb === 'runs') {
      expect(body.claimed.map((row: { job: string }) => row.job)).toEqual(['fake-new', 'fake-mid']);
      expect(body.publishesLastHour.map((row: { job: string }) => row.job)).toEqual(['fake-p2', 'fake-p1']);
      expect(body.events.map((row: { text: string }) => row.text)).toEqual(['fake newest', 'fake middle']);
      expect(body.lanes.map((row: { lane: string }) => row.lane)).toEqual(['fake-a', 'fake-b']);
      expect(body.drop.pending.map((row: { file: string }) => row.file)).toEqual(['fake-1.md', 'fake-2.md']);
      expect(body.switches).toEqual(['HOLD']);
    } else if (verb === 'journal') {
      expect(body.notes.map((row: { at: string }) => row.at)).toEqual(['fake newest note', 'fake middle note']);
      expect(body.passes).toHaveLength(1);
      expect(body.ingest.map((row: { file: string }) => row.file)).toEqual(['fake-new.md', 'fake-old.md']);
      expect(body.ingested.map((row: { id: string }) => row.id)).toEqual(['fake-id-2', 'fake-id-1']);
    } else {
      expect(body.byLane.map((row: { lane: string }) => row.lane)).toEqual(['fake-a', 'fake-b']);
      expect(body.nextUp).toHaveLength(1);
      expect(body.groups).toHaveLength(1);
      expect(body.skips.map((row: { job: string }) => row.job)).toEqual(['fake-new', 'fake-mid']);
    }
  });

  it.each(['runs', 'journal', 'parked'] as const)('%s reports truncated=false when nothing is cut and accepts the bounds', async verb => {
    const deps = readers();
    for (const bound of ['1', '200']) {
      output = [];
      expect(await cmdFleetRunsRead(verb, ['--json', '--sample', bound], deps)).toBe(0);
      const body = JSON.parse(output.join(''));
      expect(body.sampled).toBe(Number(bound));
      expect(body.truncated).toBe(bound === '1');
    }
  });

  it.each(['runs', 'journal', 'parked'] as const)('%s rejects invalid bounds before reading', async verb => {
    const deps = readers();
    const invalid = [
      ['--sample', '0'], ['--sample', '-1'], ['--sample', '1.5'], ['--sample', '1e2'], ['--sample', 'fake'],
      ['--sample', '201'], ['--sample', '200.5'], ['--sample', ''], ['--sample'],
      ['--sample', '2', '--sample', '3'], ['--sample=2'], ['--samplex', '2'],
    ];
    for (const args of invalid) {
      errors = '';
      expect(await cmdFleetRunsRead(verb, args, deps)).toBe(2);
      expect(errors.split('\n')[0]).toMatch(/^error: /);
    }
    expect(deps[verb]).not.toHaveBeenCalled();
  });

  it.each(['runs', 'journal', 'parked'] as const)('%s leaves the default path byte-for-byte unchanged', async verb => {
    const deps = readers();
    const fixtures = { runs, journal, parked };
    expect(await cmdFleetRunsRead(verb, ['--json'], deps)).toBe(0);
    expect(output).toEqual([JSON.stringify(fixtures[verb])]);
    output = [];
    expect(await cmdFleetRunsRead(verb, [], deps)).toBe(0);
    expect(output.join('\n')).not.toContain('Sample:');
    expect(output.join('\n')).not.toContain('sampled');
  });

  it('runs --check-ready rejects --sample and keeps its exact contract', async () => {
    const deps = readers();
    expect(await cmdFleetRunsRead('runs', ['--check-ready', '--json', '--sample', '5'], deps)).toBe(2);
    expect(deps.runs).not.toHaveBeenCalled();
    expect(await cmdFleetRunsRead('runs', ['--check-ready', '--json'], deps)).toBe(0);
    const body = JSON.parse(output.join(''));
    expect(body).not.toHaveProperty('sampled');
    expect(body).toMatchObject({ ready: true, eligibleLaneIds: ['fake-a', 'fake-b', 'fake-c'] });
  });

  it('composes with --lane and --rejections-only without capping filter metadata', async () => {
    const deps = readers();
    expect(await cmdFleetRunsRead('runs', ['--json', '--lane', 'fake-a', '--sample', '1'], deps)).toBe(0);
    const body = JSON.parse(output.join(''));
    expect(body.sampled).toBe(1);
    expect(body.truncated).toBe(true);
    expect(body.lanes.map((row: { lane: string }) => row.lane)).toEqual(['fake-a']);
    expect(body.claimed.map((row: { job: string }) => row.job)).toEqual(['fake-new']);
    expect(body.laneFilter).toEqual({ lane: 'fake-a', global: ['sources', 'sourceState', 'drop.done', 'other non-row fields', 'switches'], omitted: ['events'] });
    output = [];
    expect(await cmdFleetRunsRead('journal', ['--json', '--rejections-only', '--sample', '1'], deps)).toBe(0);
    const journalBody = JSON.parse(output.join(''));
    expect(journalBody.sampled).toBe(1);
    expect(journalBody.truncated).toBe(true);
    expect(journalBody.ingest.map((row: { verb: string }) => row.verb)).toEqual(['reject']);
    expect(journalBody.rejectionsFilter).toEqual({ global: ['sources', 'rejectedLastHour'], omitted: ['passes', 'ingested'] });
  });

  it('bounds every --watch snapshot and annotates each JSONL row', async () => {
    const deps = readers();
    const controller = new AbortController();
    const beforeInt = process.listeners('SIGINT');
    const beforeTerm = process.listeners('SIGTERM');
    let ticks = 0;
    const wait = vi.fn(async () => { if (++ticks === 2) controller.abort(); });
    expect(await cmdFleetRunsRead('runs', ['--watch', '--json', '--sample', '1'], deps, { signal: controller.signal, wait })).toBe(0);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(deps.runs).toHaveBeenCalledTimes(2);
    const bodies = output.map(line => JSON.parse(line));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.sampled).toBe(1);
      expect(body.truncated).toBe(true);
      expect(body.claimed.map((row: { job: string }) => row.job)).toEqual(['fake-new']);
    }
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it.each(['runs', 'journal', 'parked'] as const)('%s annotates text output without leaking private fields', async verb => {
    const deps = readers();
    expect(await cmdFleetRunsRead(verb, ['--sample', '1'], deps)).toBe(0);
    expect(output.join('\n').split('\n')[0]).toBe('Sample: newest 1 rows per collection (truncated)');
    expect(output.join('\n')).not.toContain('"sampled"');
  });

  it.each(['runs', 'journal', 'parked'] as const)('%s help documents the bound', async verb => {
    const deps = readers();
    expect(await cmdFleetRunsRead(verb, ['--help'], deps)).toBe(0);
    expect(output.join('\n')).toContain('[--sample <1..200>]');
    expect(output.join('\n')).toContain('--sample caps each emitted row collection to the newest n rows');
    expect(deps[verb]).not.toHaveBeenCalled();
  });
});
