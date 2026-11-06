import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';

const mock = vi.hoisted(() => ({ runs: vi.fn(), journal: vi.fn(), parked: vi.fn(), queue: vi.fn() }));
vi.mock('../src/core/fleet/runs-dir-state.js', () => ({ readFleetRunsDirState: mock.runs }));
vi.mock('../src/core/fleet/leader-journal.js', () => ({ readLeaderJournal: mock.journal }));
vi.mock('../src/core/fleet/runs-parked-queue.js', () => ({ readFleetQueue: mock.parked }));
vi.mock('../src/cli/router-queue.js', () => ({ cmdRouterQueue: mock.queue }));

const runs = {
  v: 1, generatedAt: '2026-10-31T00:00:00Z', runsDirPresent: true, sourceState: 'degraded',
  sources: { status: 'healthy', claimed: 'missing', events: 'degraded', metrics: 'missing', claudeLane: 'missing', switches: 'healthy', drop: 'missing' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex-personal', running: 0, target: 1, floor: null, ceiling: null, queued: 4, held: true, heldReason: 'manual hold', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  publishesLastHour: [], events: [], claimed: [], drop: { pending: [], done: 0 },
};
const journal = {
  v: 1, generatedAt: runs.generatedAt, sources: { planLog: 'missing', ingestLog: 'healthy', ingested: 'degraded' },
  passes: [], ingest: [{ verb: 'reject', file: 'fake.md', reason: 'invalid lane' }], ingested: [], rejectedLastHour: null,
};
const parked = {
  v: 1, generatedAt: runs.generatedAt, sources: { ready: 'healthy', skips: 'missing' },
  total: 3, ready: 1, parked: 2, malformed: 0, byLane: [{ lane: 'codex-personal', ready: 1, parked: 2 }],
  groups: [{ reason: 'HOLD', lane: 'codex-personal', count: 2, jobs: ['fake-1', 'fake-2'] }], skips: [], skipsLast24h: null,
};

let output: string[];
let errors: string;
beforeEach(() => {
  vi.clearAllMocks();
  mock.runs.mockResolvedValue(runs); mock.journal.mockResolvedValue(journal); mock.parked.mockResolvedValue(parked);
  mock.queue.mockResolvedValue(0);
  output = []; errors = '';
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors += String(chunk); return true; });
});
afterEach(() => vi.restoreAllMocks());

describe('fleet host runs read commands', () => {
  it.each([['runs', runs, mock.runs], ['journal', journal, mock.journal], ['parked', parked, mock.parked]] as const)(
    'returns the %s reader projection unchanged as versioned JSON', async (verb, fixture, reader) => {
      expect(await cmdFleet([verb, '--json'])).toBe(0);
      expect(JSON.parse(output.join('\n'))).toEqual(fixture);
      expect(reader).toHaveBeenCalledOnce();
      expect(reader).toHaveBeenCalledWith();
    },
  );

  it('shows holds, queued work, rejection reasons and missing sources to people', async () => {
    expect(await cmdFleet(['runs'])).toBe(0);
    expect(output.join('\n')).toMatch(/codex-personal: 0\/1 running, 4 queued; held: true \(manual hold\)/);
    expect(output.join('\n')).toContain('claimed=missing');
    output = [];
    expect(await cmdFleet(['journal'])).toBe(0);
    expect(output.join('\n')).toContain('reject fake.md: invalid lane');
    expect(output.join('\n')).toContain('Rejected last hour: unknown');
    output = [];
    expect(await cmdFleet(['parked'])).toBe(0);
    expect(output.join('\n')).toContain('HOLD (codex-personal): 2 [fake-1, fake-2]');
    expect(output.join('\n')).toContain('skips=missing');
  });

  it('applies the desktop public scrub to parked queue labels', async () => {
    const privateLabel = `${process.env.HOME}/fake-private`;
    mock.parked.mockResolvedValue({ ...parked, byLane: [{ lane: privateLabel, ready: 1, parked: 0 }] });
    expect(await cmdFleet(['parked', '--json'])).toBe(0);
    expect(output.join('\n')).not.toContain(privateLabel);
    expect(JSON.parse(output[0]!).byLane[0].lane).toBe('~/fake-private');
  });

  it.each(['runs', 'journal', 'parked'])('%s validates flags and help without reading', async verb => {
    for (const args of [['--bad'], ['--json', '--json'], ['--help', '-h'], ['--help', '--bad'], ['--runs-dir', '/tmp/fake'], ['extra']]) {
      expect(await cmdFleet([verb, ...args])).toBe(2);
    }
    expect(await cmdFleet([verb, '--help'])).toBe(0);
    expect(output.join('\n')).toContain(`phm fleet ${verb} [--json] [--help]`);
    expect(mock.runs).not.toHaveBeenCalled(); expect(mock.journal).not.toHaveBeenCalled(); expect(mock.parked).not.toHaveBeenCalled();
  });

  it.each(['runs', 'journal', 'parked'] as const)('%s hides exceptions', async verb => {
    mock[verb].mockRejectedValue(new Error('private fake exception /tmp/private'));
    expect(await cmdFleet([verb, '--json'])).toBe(1);
    expect(errors).toBe(`error: fleet ${verb} unavailable\n`);
    expect(output).toEqual([]);
  });

  it('keeps legacy queue dispatch and top-level help separate', async () => {
    expect(await cmdFleet(['queue', 'read', '--json'])).toBe(0);
    expect(mock.queue).toHaveBeenCalledWith(['read', '--json']);
    expect(await cmdFleet(['--help'])).toBe(0);
    for (const verb of ['runs', 'journal', 'parked']) expect(output.join('\n')).toContain(`phm fleet ${verb}`);
    expect(mock.runs).not.toHaveBeenCalled(); expect(mock.journal).not.toHaveBeenCalled(); expect(mock.parked).not.toHaveBeenCalled();
  });
});
