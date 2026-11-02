import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cmdFleetCanaryLadder,
  projectFleetCanaryLadder,
  readFleetMergeOutcomeSource,
  type FleetCanaryLadderDeps,
  type FleetCanaryLadderSource,
} from '../src/cli/fleet-canary-ladder.js';
import { cmdFleet } from '../src/cli/fleet.js';
import { CANARY_LADDER_DEFAULT_STATE } from '../src/core/fleet/automerge-canary-ladder.js';
import { newFleetMergeState, writeFleetMergeState } from '../src/core/fleet/fleet-merge-state.js';

// Exercise actual dispatcher routing while keeping the outcome read hermetic.
const injected = vi.hoisted(() => ({ deps: {} as FleetCanaryLadderDeps }));
vi.mock('../src/cli/fleet-canary-ladder.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/cli/fleet-canary-ladder.js')>();
  return {
    ...original,
    cmdFleetCanaryLadder: (args: string[], deps?: FleetCanaryLadderDeps) =>
      original.cmdFleetCanaryLadder(args, deps ?? injected.deps),
  };
});

const clock = () => new Date('2026-10-31T12:00:00.000Z');

function source(repos: FleetCanaryLadderSource['repos'], over: Partial<FleetCanaryLadderSource> = {}): FleetCanaryLadderSource {
  return { state: 'healthy', complete: true, records: repos.length, corrupt: 0, repos, ...over };
}

let output: string[];
let errors: string;
beforeEach(() => {
  output = [];
  errors = '';
  injected.deps = { now: clock, output: text => output.push(text) };
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    errors += String(chunk);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const report = () => JSON.parse(output.at(-1)!) as {
  schema: string; authority: string; generatedAt: string;
  gates: { hostCancellationProven: boolean; enforceSupported: boolean };
  source: { state: string; complete: boolean };
  repos: {
    repo: string; rung: string; evidence: number; promoted: boolean;
    nextStep: { event: string | null; applies: boolean; reason: string | null };
  }[];
};

describe('phm fleet canary-ladder', () => {
  it('a clean run reports the armed rung the module computes, with enforce as the refused next step', async () => {
    injected.deps.read = () => source([
      { repo: 'acme/app', outcomes: ['merged', 'merged', 'merged'] },
      { repo: 'acme/one', outcomes: ['merged'] },
    ]);
    expect(await cmdFleet(['canary-ladder', '--json'])).toBe(0);
    const body = report();
    expect(body.schema).toBe('fleet.canary-ladder.v1');
    expect(body.authority).toBe('observation-only');
    expect(body.generatedAt).toBe('2026-10-31T12:00:00.000Z');
    expect(body.gates).toEqual({ hostCancellationProven: true, enforceSupported: false });
    expect(body.repos).toEqual([
      {
        repo: 'acme/app', rung: 'armed', evidence: 3, promoted: true,
        nextStep: { event: 'enforce', applies: false, reason: 'enforce-unsupported' },
      },
      {
        repo: 'acme/one', rung: 'armed', evidence: 1, promoted: true,
        nextStep: { event: 'enforce', applies: false, reason: 'enforce-unsupported' },
      },
    ]);
    // Every held merge past armed attempted enforce and was refused by the
    // pinned gate — evidence can never reach the enforce rung.
    expect(body.repos.every((row) => row.rung !== 'enforce')).toBe(true);
  });

  it('a run with a reverted merge rolls back to shadow; a later held merge re-arms', async () => {
    injected.deps.read = () => source([
      { repo: 'acme/app', outcomes: ['merged', 'merged', 'reverted'] },
      { repo: 'acme/rearm', outcomes: ['merged', 'reverted', 'merged'] },
      { repo: 'acme/floor', outcomes: ['reverted'] },
    ]);
    expect(await cmdFleet(['canary-ladder', '--json'])).toBe(0);
    const body = report();
    expect(body.repos).toEqual([
      {
        repo: 'acme/app', rung: 'shadow', evidence: 3, promoted: false,
        nextStep: { event: 'arm', applies: true, reason: null },
      },
      {
        repo: 'acme/floor', rung: 'shadow', evidence: 1, promoted: false,
        nextStep: { event: 'arm', applies: true, reason: null },
      },
      {
        repo: 'acme/rearm', rung: 'armed', evidence: 3, promoted: true,
        nextStep: { event: 'enforce', applies: false, reason: 'enforce-unsupported' },
      },
    ]);
  });

  it('empty history stays on the default rung and never reports a promotion', async () => {
    injected.deps.read = () => source([
      { repo: 'acme/empty', outcomes: [] },
    ]);
    expect(await cmdFleet(['canary-ladder', '--json'])).toBe(0);
    const body = report();
    expect(body.repos).toEqual([
      {
        repo: 'acme/empty', rung: CANARY_LADDER_DEFAULT_STATE, evidence: 0, promoted: false,
        nextStep: { event: null, applies: false, reason: 'no-evidence' },
      },
    ]);
  });

  it('an unclassified outcome retreats to shadow like the module does for unknown input', async () => {
    injected.deps.read = () => source([
      // Runtime-untyped readers can surface strings outside the union; the
      // replay treats anything but a held merge as a rollback, never a climb.
      { repo: 'acme/odd', outcomes: ['merged', 'garbage' as 'merged', 'merged'] },
    ]);
    expect(await cmdFleet(['canary-ladder', '--json'])).toBe(0);
    const body = report();
    expect(body.repos).toEqual([
      {
        repo: 'acme/odd', rung: 'armed', evidence: 3, promoted: true,
        nextStep: { event: 'enforce', applies: false, reason: 'enforce-unsupported' },
      },
    ]);
  });

  it('a degraded source still prints its partial report and exits 1', async () => {
    injected.deps.read = () => source(
      [{ repo: 'acme/app', outcomes: ['merged'] }],
      { state: 'degraded', complete: false, corrupt: 1 },
    );
    expect(await cmdFleet(['canary-ladder', '--json'])).toBe(1);
    const body = report();
    expect(body.source).toMatchObject({ state: 'degraded', complete: false, corrupt: 1 });
    expect(body.repos[0]).toMatchObject({ repo: 'acme/app', rung: 'armed' });
  });

  it('prints a text summary without --json', async () => {
    injected.deps.read = () => source([
      { repo: 'acme/app', outcomes: ['merged', 'reverted'] },
    ]);
    expect(await cmdFleet(['canary-ladder'])).toBe(0);
    const text = output.join('\n');
    expect(text).toContain('acme/app');
    expect(text).toContain('rung=shadow');
    expect(text).toContain('evidence=2');
    expect(text).toContain('next=arm');
  });

  it.each([
    [['--json', '--json']],
    [['--bogus']],
    [['extra']],
    [['--help', '--json']],
  ])('rejects %j without reading the source', async (args) => {
    const read = vi.fn();
    injected.deps.read = read;
    expect(await cmdFleet(['canary-ladder', ...args])).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(errors).toContain('usage:');
  });

  it('--help prints usage and reads nothing', async () => {
    const read = vi.fn();
    injected.deps.read = read;
    expect(await cmdFleet(['canary-ladder', '--help'])).toBe(0);
    expect(output.join('\n')).toContain('phm fleet canary-ladder');
    expect(read).not.toHaveBeenCalled();
  });

  it('repeated runs emit identical reports: the read-only report carries no state of its own', async () => {
    injected.deps.read = () => source([{ repo: 'acme/app', outcomes: ['merged'] }]);
    expect(await cmdFleetCanaryLadder(['--json'], injected.deps)).toBe(0);
    expect(await cmdFleetCanaryLadder(['--json'], injected.deps)).toBe(0);
    expect(output[0]).toBe(output[1]);
  });
});

describe('projectFleetCanaryLadder (pure projection)', () => {
  it('reports the rung the module computes for each fixture history', () => {
    const body = projectFleetCanaryLadder(source([
      { repo: 'acme/clean', outcomes: ['merged', 'merged'] },
      { repo: 'acme/reverted', outcomes: ['merged', 'reverted'] },
      { repo: 'acme/empty', outcomes: [] },
    ]), clock());
    expect(body.repos.map((row) => [row.repo, row.rung])).toEqual([
      ['acme/clean', 'armed'],
      ['acme/empty', 'shadow'],
      ['acme/reverted', 'shadow'],
    ]);
    expect(body.repos.find((row) => row.repo === 'acme/empty')).toMatchObject({
      evidence: 0, promoted: false, nextStep: { event: null, applies: false },
    });
  });
});

describe('readFleetMergeOutcomeSource (default reader)', () => {
  const base = {
    repo: 'acme/app', repoPath: '/tmp/fake', enforcement: null,
    nowIso: '2026-10-31T00:00:00.000Z',
  };

  // writeFleetMergeState stamps updatedAt itself, so records are written in
  // intended chronological order; the reader sorts equal timestamps stably.
  function mergeRecord(key: string, kind: 'change' | 'revert'): void {
    const record = newFleetMergeState({
      key, kind, proposalId: kind === 'change' ? key : null,
      revertsLandingId: kind === 'revert' ? 'landing-1' : null,
      ...base,
    });
    record.outcome = 'merged';
    expect(writeFleetMergeState(record)).toBe(true);
  }

  // The relocated home is shared per file: declare the empty-store case
  // before any record lands so its assertions are unambiguous.
  it('reports a missing store as an empty, un-promoted report', () => {
    const read = readFleetMergeOutcomeSource();
    expect(read.state).toBe('missing');
    expect(read.complete).toBe(true);
    expect(read.records).toBe(0);
    expect(read.repos).toEqual([]);
    const body = projectFleetCanaryLadder(read, clock());
    expect(body.repos).toEqual([]);
  });

  it('orders landed merges and reverts per repo by their record timestamps', () => {
    mergeRecord('prop-1', 'change');
    mergeRecord('prop-2', 'change');
    mergeRecord('revert-1', 'revert');
    const read = readFleetMergeOutcomeSource();
    expect(read.state).toBe('healthy');
    expect(read.complete).toBe(true);
    expect(read.records).toBe(3);
    expect(read.repos).toEqual([
      { repo: 'acme/app', outcomes: ['merged', 'merged', 'reverted'] },
    ]);
    // The projection on the real reader rolls the repo back to shadow.
    expect(projectFleetCanaryLadder(read, clock()).repos[0]).toMatchObject({
      rung: 'shadow', evidence: 3, promoted: false,
      nextStep: { event: 'arm', applies: true },
    });
  });

  it('skips records that never merged; only landed outcomes count as evidence', () => {
    const closed = newFleetMergeState({
      key: 'prop-closed', kind: 'change', proposalId: 'prop-closed',
      revertsLandingId: null, ...base,
    });
    closed.outcome = 'closed';
    expect(writeFleetMergeState(closed)).toBe(true);
    const inflight = newFleetMergeState({
      key: 'prop-inflight', kind: 'change', proposalId: 'prop-inflight',
      revertsLandingId: null, ...base,
    });
    expect(writeFleetMergeState(inflight)).toBe(true);
    const read = readFleetMergeOutcomeSource();
    expect(read.records).toBe(5);
    // All five records were read; only the three landed merges contribute.
    expect(read.repos).toEqual([
      { repo: 'acme/app', outcomes: ['merged', 'merged', 'reverted'] },
    ]);
  });
});
