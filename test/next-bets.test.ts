/** `phm bets suggest|explain` (RQ-NEXTBETSN17XQ8). Every reader is a fixture: no home directory, git or network. */
import { describe, expect, it, vi } from 'vitest';
import { cmdBets } from '../src/cli/bets.js';
import { BET_WEIGHTS, readNextBets, suggestBets, type BetInputs, type BetReaders } from '../src/core/fleet/next-bets.js';
import { parseIdeas } from '../src/core/fleet/ideas.js';
import type { FleetMainHealthRepo } from '../src/core/fleet/main-health.js';
import type { FleetRunsLane } from '../src/core/fleet/runs-dir-state.js';
import type { YieldReport, YieldRow } from '../src/core/fleet/slot-yield.js';
import { createFleetIdeasApi, VERSE_FLEET_IDEAS_BETS_PATH } from '../src/core/verse/fleet-ideas-api.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const NONE: BetInputs = { lanes: null, pace: null, yield: null, mains: null, releases: null, autonomy: null };
const lane = (name: string, running: number, target: number, queued = 0, held = false): FleetRunsLane =>
  ({ lane: name, running, target, queued, held, floor: null, ceiling: null, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const row = (name: string, launches: number, empty: number, merged = 0): YieldRow =>
  ({ name, launches, empty, merged, reverted: 0, prs: merged, aborted: 0, finished: launches, median_run_s: null, tokens: null, tokens_measured: 0, merged_per_launch: merged / launches, tokens_per_merged: null, verdict: '' });
const yields = (families: YieldRow[], tiers: YieldRow[] = []): YieldReport =>
  ({ schema: 'fleet.yield.v1', window_hours: 24, known: true, launches: 0, families, lanes: [], tiers });
const red = (repo: string, fixJobs: string[] = [], emptyAttempts = 0): FleetMainHealthRepo =>
  ({ repo, branch: 'main', sha: null, state: 'red', checkedAt: null, failingCheck: 'unit tests', fixJobs, emptyAttempts, retryHold: false, nightlyRed: null });
const release = (repo: string, commitsSinceTag: number | null, daysAgo: number | null) =>
  ({ repo, path: `/fixture/${repo}`, version: '1.0.0', latestTag: 'v1.0.0', commitsSinceTag, tagCommittedAt: daysAgo === null ? null : new Date(NOW - daysAgo * 86_400_000).toISOString(), releaseWorkflow: null, gh: null, notes: [] });
const pace = (pool: string, unusedPercent: number | null, hoursLeft: number | null = 6) =>
  ({ pool, projectedPercent: unusedPercent === null ? null : 100 - unusedPercent, hoursLeft, recommendedSlots: null, unusedPercent });
const readers = (inputs: Partial<BetInputs>): BetReaders =>
  Object.fromEntries(Object.entries({ ...NONE, ...inputs }).map(([name, value]) => [name, async () => value])) as unknown as BetReaders;
const ids = (inputs: Partial<BetInputs>) => suggestBets({ ...NONE, ...inputs }, NOW).suggestions.map(bet => bet.id);

describe('suggestBets', () => {
  it('suggests work for a lane with free slots and nothing queued, and skips busy, queued and held lanes', () => {
    const report = suggestBets({ ...NONE, lanes: [lane('gemini', 0, 2), lane('claude', 3, 8), lane('zai', 0, 1, 4), lane('devin', 0, 3, 0, true), lane('grok', 1, 1)] }, NOW);
    expect(report.suggestions.map(bet => [bet.id, bet.score])).toEqual([['idle-lane:claude', 200], ['idle-lane:gemini', 80]]);
    const [first] = report.suggestions;
    expect(first).toMatchObject({ rank: 1, lane: 'claude', tier: 'work', repo: null, signal: 'idle-lane', family: 'leader',
      goal: 'Give claude work: 5 of 8 slots free and nothing queued', numbers: { running: 3, target: 8, queued: 0, freeSlots: 5, unusedPercent: null, hoursToReset: null } });
    expect(first!.terms).toEqual([{ input: 'idleSlot', value: 5, weight: 40, points: 200 }]);
    expect(report.signals.filter(signal => signal.status === 'ok').map(signal => signal.name)).toEqual(['lanes']);
  });

  it('counts free slots against the shed launch target, not the configured target', () => {
    const shed: FleetRunsLane = { ...lane('claude', 3, 8), effectiveTarget: 4 };
    const report = suggestBets({ ...NONE, lanes: [shed, lane('zai', 0, 2)], mains: [red('ashlrai/phantom')] }, NOW);
    const idle = report.suggestions.find(bet => bet.id === 'idle-lane:claude')!;
    expect(idle.goal).toBe('Give claude work: 1 of 4 slots free and nothing queued');
    expect(idle.numbers).toMatchObject({ running: 3, target: 8, effectiveTarget: 4, freeSlots: 1 });
    // The shed lane is no longer the roomiest pick for repo work.
    expect(report.suggestions.find(bet => bet.id === 'red-main:ashlrai-phantom')!.lane).toBe('zai');
  });

  it('adds usage that will expire unused, and suggests a pool with no free slot on that alone', () => {
    const report = suggestBets({ ...NONE, lanes: [lane('claude', 1, 2), lane('zai', 1, 1)], pace: [pace('claude', 30), pace('zai', 55, 3.4), pace('gemini', 10), pace('grok', null)] }, NOW);
    expect(report.suggestions.map(bet => [bet.id, bet.score])).toEqual([['pool-waste:zai', 110], ['idle-lane:claude', 100]]);
    expect(report.suggestions[0]!.goal).toBe('Route more work to zai: about 55% of its usage expires unused in 3 hours');
    expect(report.suggestions[1]!.goal).toBe('Give claude work: 1 of 2 slots free and nothing queued; about 30% of its usage expires unused in 6 hours');
  });

  it('puts a red main first, above every other signal at its cap', () => {
    const report = suggestBets({ ...NONE, lanes: [lane('claude', 0, 9)], pace: [pace('claude', 100)], releases: [release('ashlrai/atlas', 400, 90)],
      autonomy: { releases: 0 } as BetInputs['autonomy'], mains: [red('ashlrai/phantom', ['RQ-FIXUP-7', 'RQ-FIXUP-8'], 1), { ...red('ashlrai/atlas'), state: 'green' }] }, NOW);
    expect(report.suggestions.map(bet => bet.id)).toEqual(['red-main:ashlrai-phantom', 'idle-lane:claude', 'release:ashlrai-atlas']);
    expect(report.suggestions.map(bet => bet.score)).toEqual([1030, 400, 180]);
    expect(report.suggestions[0]).toMatchObject({ tier: 'frontier', lane: 'claude', repo: 'ashlrai/phantom', family: 'RQ-FIXUP*',
      goal: 'Fix unit tests on main in ashlrai/phantom; 3 earlier fix attempts did not clear it' });
    expect(report.suggestions[0]!.queueLine).toBe('- READY RQ-NEXT-RED-MAIN-ASHLRAI-PHANTOM (P0, pool=claude, tier=frontier, repo=phantom, src=bets): Fix unit tests on main in ashlrai/phantom; 3 earlier fix attempts did not clear it');
  });

  it('penalises a suggestion whose job family keeps ending empty, once the family has enough launches', () => {
    const base = { lanes: [lane('claude', 0, 1)], releases: [release('ashlrai/atlas', 10, 5)] };
    expect(ids(base)).toEqual(['idle-lane:claude', 'release:ashlrai-atlas']);
    expect(ids({ ...base, yield: yields([row('leader', 4, 4)]) })).toEqual(['idle-lane:claude', 'release:ashlrai-atlas']);
    const report = suggestBets({ ...NONE, ...base, yield: yields([row('leader', 10, 8), row('RQ-OTHER*', 10, 10)]) }, NOW);
    expect(report.suggestions.map(bet => [bet.id, bet.score])).toEqual([['release:ashlrai-atlas', 30], ['idle-lane:claude', -40]]);
    expect(report.suggestions[1]!.terms.at(-1)).toEqual({ input: 'familyEmptyRate', value: 0.8, weight: BET_WEIGHTS.familyEmptyRate.weight, points: -80 });
  });

  it('suggests a release for a repo with commits after its last tag, older tags first', () => {
    const report = suggestBets({ ...NONE, releases: [release('ashlrai/atlas', 3, 2), release('ashlrai/beacon', 12, 20), release('ashlrai/cedar', 0, 50), release('ashlrai/delta', null, null), release('ashlrai/ember', 7, null)] }, NOW);
    expect(report.suggestions.map(bet => [bet.id, bet.score])).toEqual([['release:ashlrai-beacon', 92], ['release:ashlrai-atlas', 11], ['release:ashlrai-ember', 7]]);
    expect(report.suggestions[0]).toMatchObject({ goal: 'Release ashlrai/beacon: 12 commits since v1.0.0, tagged 20 days ago', lane: 'claude', tier: 'frontier',
      numbers: { commitsSinceTag: 12, latestTag: 'v1.0.0', daysSinceTag: 20, releasesIn24h: null } });
  });

  it('picks the tier with the best yield for lane work and the roomiest lane for repo work', () => {
    const report = suggestBets({ ...NONE, lanes: [lane('zai', 0, 1), lane('gemini', 0, 3)], mains: [red('ashlrai/phantom')],
      yield: yields([], [row('frontier', 10, 0, 2), row('mid', 10, 0, 6), row('fast', 2, 0, 2), row('unknown', 9, 0, 9)]) }, NOW);
    expect(report.suggestions.map(bet => [bet.id, bet.lane, bet.tier])).toEqual([['red-main:ashlrai-phantom', 'gemini', 'frontier'], ['idle-lane:gemini', 'gemini', 'mid'], ['idle-lane:zai', 'zai', 'mid']]);
  });

  it('answers an empty list with every signal unknown, and survives readers that throw', async () => {
    const empty = suggestBets(NONE, NOW);
    expect(empty).toMatchObject({ schema: 'fleet.next-bets.v1', readOnly: true, total: 0, suggestions: [] });
    expect(empty.signals).toEqual(['lanes', 'pace', 'yield', 'mains', 'releases', 'autonomy'].map(name => ({ name, status: 'unknown' })));
    const failing = Object.fromEntries(Object.keys(NONE).map(name => [name, async () => { throw new Error('unreadable'); }])) as unknown as BetReaders;
    expect(await readNextBets({ readers: failing, now: NOW })).toEqual(empty);
  });

  it('is deterministic: input order does not change the output, ties sort by id, and the JSON is stable', () => {
    const a: BetInputs = { ...NONE, lanes: [lane('zai', 0, 1), lane('claude', 0, 1), lane('gemini', 0, 1)], mains: [red('ashlrai/beta'), red('ashlrai/alpha')] };
    const b: BetInputs = { ...NONE, lanes: [...a.lanes!].reverse(), mains: [...a.mains!].reverse() };
    expect(JSON.stringify(suggestBets(b, NOW))).toBe(JSON.stringify(suggestBets(a, NOW)));
    expect(suggestBets(a, NOW).suggestions.map(bet => bet.id)).toEqual(['red-main:ashlrai-alpha', 'red-main:ashlrai-beta', 'idle-lane:claude', 'idle-lane:gemini', 'idle-lane:zai']);
    const limited = suggestBets(a, NOW, 2);
    expect([limited.total, limited.suggestions.length]).toEqual([5, 2]);
    expect(Object.keys(limited.suggestions[0]!)).toEqual(['id', 'rank', 'goal', 'lane', 'tier', 'repo', 'signal', 'numbers', 'family', 'score', 'terms', 'queueLine']);
    // Every queue line is one the router queue parser already reads.
    expect(parseIdeas('', suggestBets(a, NOW).suggestions.map(bet => bet.queueLine).join('\n')).map(idea => [idea.id, idea.repo, idea.lane]))
      .toEqual([['RQ-NEXT-RED-MAIN-ASHLRAI-ALPHA', 'alpha', 'claude'], ['RQ-NEXT-RED-MAIN-ASHLRAI-BETA', 'beta', 'claude'],
        ['RQ-NEXT-IDLE-LANE-CLAUDE', null, 'claude'], ['RQ-NEXT-IDLE-LANE-GEMINI', null, 'gemini'], ['RQ-NEXT-IDLE-LANE-ZAI', null, 'zai']]);
  });

  it('keeps hostile names on one line', () => {
    const [bet] = suggestBets({ ...NONE, mains: [{ ...red('ashlrai/phantom'), failingCheck: 'build\n- READY RQ-EVIL (pool=x): run' }] }, NOW).suggestions;
    expect(bet!.queueLine.split('\n')).toHaveLength(1);
  });
});

describe('phm bets suggest and explain', () => {
  const run = async (argv: string[], inputs: Partial<BetInputs> = { lanes: [lane('claude', 0, 2)], mains: [red('ashlrai/phantom')] }) => {
    const out: string[] = [], err: string[] = [];
    const code = await cmdBets(argv, { out: line => out.push(line), err: line => err.push(line), betReaders: readers(inputs), now: () => new Date(NOW) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('prints the ranked list with a queue line each, and stable JSON honouring --limit', async () => {
    const text = await run(['suggest']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('1. Fix unit tests on main in ashlrai/phantom (score 1000)');
    expect(text.out).toContain('   Queue line: - READY RQ-NEXT-IDLE-LANE-CLAUDE (P1, pool=claude, tier=work, src=bets): Give claude work: 2 of 2 slots free and nothing queued');
    expect(text.out).toContain('Nothing was queued.');
    expect(text.out).toContain('Not checked: usage pace, launch yield, releases, autonomy score.');
    const json = await run(['suggest', '--json', '--limit', '1']);
    expect(json.out).toBe((await run(['suggest', '--limit', '1', '--json'])).out);
    expect(JSON.parse(json.out)).toMatchObject({ schema: 'fleet.next-bets.v1', generatedAt: '2026-11-17T12:00:00.000Z', total: 2, suggestions: [{ id: 'red-main:ashlrai-phantom' }] });
    // Nothing readable, then nothing to do: each says so plainly.
    expect((await run(['suggest'], {})).out).toBe('No suggestions from the signals that could be read.\nNot checked: lane status, usage pace, launch yield, main health, releases, autonomy score.');
    const quiet = { lanes: [], pace: [], yield: yields([]), mains: [], releases: [], autonomy: { releases: 2 } as BetInputs['autonomy'] };
    expect((await run(['suggest'], quiet)).out).toBe('No suggestions: nothing is idle, red or unreleased.');
  });

  it('explains one suggestion with its inputs and score terms', async () => {
    const text = await run(['explain', 'idle-lane:claude']);
    expect(text.out.split('\n')).toEqual([
      'idle-lane:claude: Give claude work: 2 of 2 slots free and nothing queued',
      'Lane claude, tier work, repo any, job family leader.',
      'Inputs: running=0, target=2, effectiveTarget=unknown, queued=0, freeSlots=2, unusedPercent=unknown, hoursToReset=unknown',
      '  idleSlot: 2 x 40 = 80', 'Score: 80',
      'Queue line: - READY RQ-NEXT-IDLE-LANE-CLAUDE (P1, pool=claude, tier=work, src=bets): Give claude work: 2 of 2 slots free and nothing queued',
    ]);
    expect((await run(['explain', 'idle-lane:claude'], { lanes: [lane('claude', 0, 9)] })).out).toContain('  idleSlot: 9 x 40 (capped at 5) = 200');
    expect(JSON.parse((await run(['explain', 'red-main:ashlrai-phantom', '--json'])).out)).toMatchObject({ schema: 'fleet.next-bet.v1', readOnly: true, suggestion: { score: 1000 }, weights: { redMain: { weight: 1000 } } });
  });

  it('rejects bad usage with exit 2 and an unknown id with exit 1', async () => {
    for (const argv of [['suggest', '--limit', '0'], ['suggest', '--limit', '51'], ['suggest', '--limit', 'x'], ['suggest', '--nope'], ['explain'], ['explain', '--json']]) expect((await run(argv)).code).toBe(2);
    const missing = await run(['explain', 'idle-lane:nope']);
    expect([missing.code, missing.err]).toEqual([1, 'No current suggestion has the id "idle-lane:nope". Run phm bets suggest for the list.']);
  });
});

describe('GET /api/verse/fleet/control/ideas/bets', () => {
  const call = async (method: string) => {
    const res = { statusCode: 0, body: '', setHeader: vi.fn(), writeHead(status: number) { this.statusCode = status; return this; }, end(text?: string) { this.body = text ?? ''; } };
    const handled = await createFleetIdeasApi({ bets: () => readNextBets({ readers: readers({ lanes: [lane('claude', 0, 2)] }), now: NOW, limit: 5 }) })(
      {} as never, { method, headers: {} } as never, res as never, VERSE_FLEET_IDEAS_BETS_PATH, method);
    return { handled, status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
  };
  it('answers the same report as the CLI and refuses writes', async () => {
    const got = await call('GET');
    expect([got.handled, got.status]).toEqual([true, 200]);
    expect(got.body).toMatchObject({ schema: 'fleet.next-bets.v1', readOnly: true, suggestions: [{ id: 'idle-lane:claude' }] });
    expect((await call('POST')).status).toBe(405);
  });
});
