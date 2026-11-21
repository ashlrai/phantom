import { describe, expect, it, vi } from 'vitest';
import { laneYieldFromRuns, laneYieldLines, readLaneYield, unknownLaneYield, LANE_YIELD_SCHEMA } from '../src/core/fleet/lane-yield-board.js';
import { cmdFleetYield } from '../src/cli/fleet-yield.js';
import { yieldTally } from '../src/core/fleet/slot-yield.js';

const now = Date.parse('2026-11-17T00:00:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const row = (fields: Record<string, unknown>) => JSON.stringify(fields);
const launch = (job: string, lane: string, minutesAgo: number) => row({ event: 'launch', job, lane, ts: at(minutesAgo) });
const finish = (job: string, minutesAgo: number, empty = false) => row({ event: 'finish', job, empty, ts: at(minutesAgo) });
const publish = (job: string, n: number, minutesAgo: number) => row({ event: 'publish', job, class: 'pr', url: `https://example.invalid/pr/${n}`, ts: at(minutesAgo) });
const merged = (job: string, minutesAgo: number) => row({ event: 'outcome', job, state: 'MERGED', ts: at(minutesAgo) });

/** alpha: 4 launches, 2 merged (one merge recorded twice). beta: 3 launches, nothing merged. gamma: 1 launch, 1 empty. */
const lines = [
  launch('Aone', 'alpha', 300), finish('Aone', 290), publish('Aone', 1, 289), merged('Aone', 280),
  merged('Aone', 279),
  launch('Atwo', 'alpha', 200), finish('Atwo', 190), publish('Atwo', 2, 189), merged('Atwo', 170),
  launch('Athree', 'alpha', 100), finish('Athree', 90, true),
  launch('Afour', 'alpha', 50),
  launch('Bone', 'beta', 400), finish('Bone', 390, true), launch('Btwo', 'beta', 300), finish('Btwo', 290, true),
  launch('Bthree', 'beta', 100), finish('Bthree', 90),
  launch('Gone', 'gamma', 60), finish('Gone', 50, true),
  merged('Old', 10),
  'not json',
];

describe('lane yield board', () => {
  const report = () => { const t = yieldTally(now, 24); lines.forEach(l => t.add(l)); return laneYieldFromRuns(t.runs(), 24); };

  it('counts each lane and credits a repeated merge once', () => {
    const r = report();
    expect(r.schema).toBe(LANE_YIELD_SCHEMA);
    expect(r.lanes.map(l => l.lane)).toEqual(['alpha', 'beta', 'gamma']);
    const [alpha, beta, gamma] = r.lanes;
    expect(alpha).toMatchObject({ launches: 4, finished: 3, prs_opened: 2, merged: 2, merged_per_launch: 0.5, not_paying_off: false });
    expect(alpha!.empty_rate).toBeCloseTo(1 / 3);
    expect(alpha!.median_minutes_to_merge).toBe(25.5); // 21 and 30 minutes from launch to the last merge row
    expect(beta).toMatchObject({ launches: 3, merged: 0, not_paying_off: true, median_minutes_to_merge: null });
    expect(beta!.sentence).toContain('not paying off');
    expect(gamma).toMatchObject({ launches: 1, merged: 0, not_paying_off: false });
    expect(r.merged).toBe(2);
    expect(r.summary).toBe('Last 24 h: 2 merged PRs. Best lane: alpha (0.50 merged per launch). Weakest: gamma (0.00).');
  });

  it('says so plainly when nothing ran, and omits lanes with no launches', async () => {
    const empty = await readLaneYield('x', 24, now, async () => true);
    expect(empty.known).toBe(true);
    expect(empty.lanes).toEqual([]);
    expect(empty.summary).toBe('No jobs in this window (last 24 h).');
    expect(laneYieldLines(empty)).toEqual(['No jobs in this window (last 24 h).']);
  });

  it('keeps an unreadable ledger unknown', async () => {
    expect(await readLaneYield('x', 24, now, async () => false)).toEqual(unknownLaneYield(24));
  });

  it('prints through phm fleet yield --by lane, text and json', async () => {
    const read = async (_p: string, on: (l: string) => void) => { lines.forEach(on); return true; };
    const out: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    try {
      expect(await cmdFleetYield(['--by', 'lane', '--since', '24h'], read, now)).toBe(0);
      expect(out[0]).toContain('Last 24 h: 2 merged PRs. Best lane: alpha');
      out.length = 0;
      expect(await cmdFleetYield(['--by', 'lane', '--json'], read, now)).toBe(0);
      expect(JSON.parse(out[0]!).schema).toBe('fleet.lane-yield.v1');
    } finally { spy.mockRestore(); }
  });
});
