import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetUnfed } from '../src/cli/fleet-unfed.js';
import { currentUnfed, foldUnfedHistory, readyHints, renderUnfed } from '../src/core/fleet/unfed-capacity.js';

let dir: string;
const saved = process.env.ASHLR_RUNS_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-unfed-'));
  mkdirSync(join(dir, 'queue'));
  mkdirSync(join(dir, 'metrics'));
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const LANES = {
  'codex-cmp': { running: 1, target: 5, effective_target: 4, held: false, queued: 0 },
  'codex-personal': { running: 2, target: 2, held: false, queued: 3 },
  devin: { running: 0, target: 3, held: true, queued: 0 },
  claude: { running: 0, target: 0, held: false, queued: 0 },
};
const row = (job: string, lane: string) => [job, 'phantom', lane, 'work', `/q/prompts/${job}.md`].join('\t');
const READY = [
  row('RQ-A', 'codex-personal'), row('RQ-B', 'codex-personal'), row('RQ-C', 'codex-personal'),
  row('RQ-D', 'codex-cmp'), ['RQ-PARKED', 'phantom', 'PARKED-DEP.codex-personal', 'work', '/q/p.md'].join('\t'),
  '# comment', '',
].join('\n');
const unfedRow = (ts: number, lanes: Record<string, unknown>) =>
  JSON.stringify({ schema: 'work-market.v1', event: 'unfed_capacity', ts, lanes });

async function run(args: string[] = ['--json']) {
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const code = await cmdFleetUnfed(args);
  return { code, lines: out.mock.calls.map(c => String(c[0])), errors: err.mock.calls.length };
}

describe('readyHints', () => {
  it('counts runnable rows by lane hint and skips parked rows, comments and short rows', () => {
    const hints = readyHints(READY + '\nRQ-SHORT\tphantom\tcodex-cmp');
    expect(hints.waiting).toBe(4);
    expect(Object.fromEntries(hints.byLane)).toEqual({ 'codex-personal': 3, 'codex-cmp': 1 });
  });
});

describe('currentUnfed', () => {
  it('derives unfed lanes from counts and hints when the dispatcher publishes no block', () => {
    const report = currentUnfed(JSON.stringify({ lanes: LANES }), READY);
    expect(report.source).toBe('derived');
    expect(report.waiting).toBe(4);
    expect(report.unfedLanes).toEqual(['codex-cmp']);
    expect(report.unfedSlots).toBe(3);
    const byLane = Object.fromEntries(report.resources.map(r => [r.lane, r]));
    // The effective target, not the stored one, bounds headroom.
    expect(byLane['codex-cmp']).toEqual({
      lane: 'codex-cmp', running: 1, target: 4, held: false, utilization: 0.25, headroom: 3,
      readyHinted: 1, waitingElsewhere: 3, unfed: true, blocked: {},
    });
    expect(byLane['codex-personal']).toMatchObject({ utilization: 1, headroom: 0, unfed: false, waitingElsewhere: 0 });
    // Held and zero-target lanes are never unfed.
    expect(byLane.devin).toMatchObject({ held: true, headroom: 3, unfed: false });
    expect(byLane.claude).toMatchObject({ utilization: null, unfed: false });
  });

  it('prefers the dispatcher verdict and keeps only well-formed reason codes', () => {
    const status = JSON.stringify({
      lanes: LANES,
      unfed_capacity: {
        waiting: 2,
        lanes: {
          'codex-cmp': { waiting_elsewhere: 2, blocked: { missing_capability: 2, 'RQ-LEAK text': 1, saturated: -1, lower_rank: 0 } },
          'codex-personal': { waiting_elsewhere: 0, blocked: {} },
        },
      },
    });
    const report = currentUnfed(status, READY);
    expect(report.source).toBe('dispatcher');
    expect(report.waiting).toBe(2);
    expect(report.unfedSlots).toBe(2);
    expect(report.resources.find(r => r.lane === 'codex-cmp')?.blocked).toEqual({ missing_capability: 2 });
    // A lane the dispatcher did not report is not guessed at.
    expect(report.resources.find(r => r.lane === 'devin')?.waitingElsewhere).toBe(0);
  });

  it('reports nothing unfed when every waiting row is hinted at the idle lane', () => {
    const report = currentUnfed(JSON.stringify({ lanes: { a: { running: 0, target: 2 } } }), row('RQ-A', 'a'));
    expect(report.unfedLanes).toEqual([]);
    expect(report.resources[0]).toMatchObject({ readyHinted: 1, waitingElsewhere: 0 });
  });

  it('rejects malformed status', () => {
    expect(() => currentUnfed('{"lanes":{"a":{"running":"1","target":2}}}', '')).toThrow();
    expect(() => currentUnfed('{"lanes":{"a":{"running":1}}}', '')).toThrow();
    expect(() => currentUnfed('[]', '')).toThrow();
  });
});

describe('foldUnfedHistory', () => {
  const now = 1_800_000_000_000;
  const t = now / 1000;
  it('folds unfed ticks inside the window and skips everything else', () => {
    const text = [
      unfedRow(t - 60, { 'codex-cmp': { unfed: true, headroom: 3, waiting_elsewhere: 2, blocked: { missing_capability: 2 } }, claude: { unfed: false, headroom: 0, waiting_elsewhere: 0 } }),
      unfedRow(t - 120, { 'codex-cmp': { unfed: true, headroom: 1, waiting_elsewhere: 5, blocked: { missing_capability: 4, provider_backoff: 1 } }, devin: { unfed: true, headroom: 2, waiting_elsewhere: 2, blocked: {} } }),
      unfedRow(t - 25 * 3600, { 'codex-cmp': { unfed: true, headroom: 9, waiting_elsewhere: 9 } }),
      unfedRow(t + 3600, { 'codex-cmp': { unfed: true, headroom: 9, waiting_elsewhere: 9 } }),
      JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job: 'RQ-X', ts: t - 60 }),
      '{"event":"unfed_capacity" broken',
      unfedRow(t - 30, { 'bad lane!': { unfed: true, headroom: 1, waiting_elsewhere: 1 }, ok: { unfed: true, headroom: -1, waiting_elsewhere: 1 } }),
    ].join('\n');
    const history = foldUnfedHistory(text, now, 24);
    expect(history).toMatchObject({ windowHours: 24, available: true, ticks: 2 });
    expect(history.lanes).toEqual([
      { lane: 'codex-cmp', unfedTicks: 2, slotTicks: 3, lastUnfedAt: new Date((t - 60) * 1000).toISOString(), blocked: { missing_capability: 6, provider_backoff: 1 } },
      { lane: 'devin', unfedTicks: 1, slotTicks: 2, lastUnfedAt: new Date((t - 120) * 1000).toISOString(), blocked: {} },
    ]);
  });
  it('says when there is no history file', () => {
    expect(foldUnfedHistory(null, now, 24)).toEqual({ windowHours: 24, available: false, ticks: 0, lanes: [] });
    expect(foldUnfedHistory('', now, 24)).toEqual({ windowHours: 24, available: true, ticks: 0, lanes: [] });
  });
});

describe('phm fleet unfed', () => {
  it('is registered as a fleet verb', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS.unfed!();
    expect(mod.cmdFleetUnfed).toBe(cmdFleetUnfed);
  });

  it('prints usage for --help and rejects unknown or out-of-range arguments', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.lines[0]).toContain('Usage: phm fleet unfed');
    for (const args of [['--nope'], ['--window'], ['--window', '0'], ['--window', '169'], ['--window', 'abc'], ['--json', '--json']]) {
      const bad = await run(args);
      expect(bad.code).toBe(2);
      expect(bad.errors).toBe(1);
      vi.restoreAllMocks();
    }
  });

  it('exits 2 with a typed error when status.json is missing or malformed', async () => {
    const missing = await run();
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.lines[0]!)).toMatchObject({ schema: 'fleet.unfed.v1', readOnly: true, error: expect.any(String) });
    vi.restoreAllMocks();
    writeFileSync(join(dir, 'queue', 'status.json'), '{"lanes":[]}');
    expect((await run([])).code).toBe(2);
  });

  it('reports utilization, unfed lanes and windowed history from the runs directory', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({ lanes: LANES }));
    writeFileSync(join(dir, 'queue', 'ready.tsv'), READY);
    const t = Date.now() / 1000;
    writeFileSync(join(dir, 'metrics', 'work-market.jsonl'), [
      unfedRow(t - 600, { 'codex-cmp': { unfed: true, headroom: 2, waiting_elsewhere: 4, blocked: { missing_capability: 4 } } }),
      unfedRow(t - 3 * 3600, { 'codex-cmp': { unfed: true, headroom: 1, waiting_elsewhere: 1, blocked: {} } }),
    ].join('\n') + '\n');
    const json = await run(['--json', '--window', '1']);
    expect(json.code).toBe(1);
    const report = JSON.parse(json.lines[0]!);
    expect(report).toMatchObject({ schema: 'fleet.unfed.v1', readOnly: true, source: 'derived', unfedLanes: ['codex-cmp'], unfedSlots: 3 });
    expect(report.history).toMatchObject({ windowHours: 1, available: true, ticks: 1 });
    expect(report.history.lanes[0]).toMatchObject({ lane: 'codex-cmp', unfedTicks: 1, slotTicks: 2 });
    vi.restoreAllMocks();
    const text = await run([]);
    expect(text.code).toBe(1);
    const body = text.lines.join('\n');
    expect(body).toContain('codex-cmp  1/4 running (25%), 1 hinted here  UNFED: 3 free, 3 rows waiting elsewhere');
    expect(body).toContain('devin  0/3 running (0%), 0 hinted here  HELD');
    expect(body).toContain('3 slot(s) could be filled now across codex-cmp; 4 rows waiting.');
    expect(body).toContain('Last 24h: 2 tick(s) left capacity unfed.');
    expect(body).toContain('codex-cmp: 2 tick(s), 3 slot-tick(s) lost (missing_capability 4)');
  });

  it('exits 0 with no unfed capacity and no history file', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({ lanes: { a: { running: 2, target: 2 } } }));
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([
      'a  2/2 running (100%), 0 hinted here',
      'No unfed capacity: 0 rows waiting.',
      'Derived from lane counts and ready.tsv hints: this dispatcher does not publish reasons.',
      'Last 24h: no metrics/work-market.jsonl history.',
    ]);
  });
});

describe('renderUnfed', () => {
  it('says so when there are no lanes', () => {
    const report = { ...currentUnfed('{"lanes":{}}', ''), history: foldUnfedHistory('', 0, 24) };
    expect(renderUnfed(report)).toEqual(['No lanes in queue/status.json.', 'No unfed capacity: 0 rows waiting.',
      'Derived from lane counts and ready.tsv hints: this dispatcher does not publish reasons.', 'Last 24h: no unfed ticks recorded.']);
  });
});

describe('derived market reasons', () => {
  const MLANES = {
    'codex-cmp': { running: 0, target: 2, held: false },
    cursor: { running: 0, target: 2, held: false },
    'codex-local': { running: 0, target: 1, held: false },
  };
  const mrow = (job: string, lane: string, tier: string, req?: string) =>
    [job, 'phantom', lane, tier, `/q/prompts/${job}.md`, ...(req === undefined ? [] : [req])].join('\t');
  const SLOTS = JSON.stringify({ 'codex-cmp': {}, cursor: { tiers: ['fast', 'work'] }, 'codex-local': {} });
  const READY2 = [
    mrow('RQ-F1', 'claude', 'frontier'), mrow('RQ-F2', 'claude', 'fast'),
    mrow('RQ-F3', 'claude', 'work', '{"preferred_lane":"codex-local"}'),
    mrow('RQ-F4', 'claude', 'mid', '{"needs":["secrets:MISSING"]}'),
  ].join('\n');

  it("recomputes blocked reason codes from the dispatcher inputs", () => {
    const report = currentUnfed(JSON.stringify({ lanes: MLANES }), READY2, { slots: SLOTS });
    expect(report.source).toBe('derived');
    expect(report.derivedReasons).toBe(true);
    const byLane = Object.fromEntries(report.resources.map(r => [r.lane, r]));
    // cursor serves only fast/work and has no cost class: frontier rows are tier_unavailable,
    // every row pays cost_class_unknown, the codex-local pin is local_execution_required,
    // and the secrets need is missing_capability.
    expect(byLane.cursor!.blocked).toEqual({
      tier_unavailable: 2, cost_class_unknown: 4, local_execution_required: 1, missing_capability: 1,
    });
    // codex-cmp is a builtin with all tiers: only the pinned and secrets rows are truly blocked.
    expect(byLane['codex-cmp']!.blocked).toEqual({
      local_execution_required: 1, missing_capability: 1, deferred_after_selection: 2,
    });
    // codex-local is a local lane: open rows need local_opt_in_required.
    expect(byLane['codex-local']!.blocked).toEqual({
      local_opt_in_required: 3, tier_unavailable: 1, missing_capability: 1,
    });
  });

  it('keeps reasons unknown when slots.json is absent or unparsable', () => {
    for (const market of [undefined, { slots: null }, { slots: 'not json' }]) {
      const report = currentUnfed(JSON.stringify({ lanes: MLANES }), READY2, market);
      expect(report.derivedReasons).toBe(false);
      expect(report.resources.every(r => Object.keys(r.blocked).length === 0)).toBe(true);
    }
  });

  it('does not recompute reasons when the dispatcher published its verdict', () => {
    const status = JSON.stringify({
      lanes: MLANES,
      unfed_capacity: { waiting: 1, lanes: { 'codex-cmp': { waiting_elsewhere: 1, blocked: { saturated: 1 } } } },
    });
    const report = currentUnfed(status, READY2, { slots: SLOTS });
    expect(report.source).toBe('dispatcher');
    expect(report.derivedReasons).toBe(false);
    expect(report.resources.find(r => r.lane === 'codex-cmp')!.blocked).toEqual({ saturated: 1 });
  });
});

describe('fleet stop verdicts', () => {
  const STOP_LANES = { a: { running: 0, target: 2, held: false }, b: { running: 1, target: 1, held: false } };
  const TWO_WAITING = [row('RQ-A', 'b'), row('RQ-B', 'b')].join('\n');

  it('reports admission_stopped from a pause marker or a tripped admission gate', () => {
    for (const extra of [
      { paused: 'maintenance window' },
      { admission: { gate_reason: 'loadavg 8.0 > 4.0 (2 x ncpu)', admit: false, decision: 'stop' } },
    ]) {
      const report = currentUnfed(JSON.stringify({ lanes: STOP_LANES, ...extra }), TWO_WAITING);
      expect(report.source).toBe('derived');
      expect(report.fleetStop).toBe('admission_stopped');
      expect(report.resources.find(r => r.lane === 'a')!.blocked).toEqual({ admission_stopped: 2 });
      expect(report.resources.find(r => r.lane === 'b')!.blocked).toEqual({});
    }
  });

  it('reports global_admission when the fleet cap or launch budget was spent', () => {
    for (const extra of [
      { admission: { running: 4, cap: 4, claim_limit: 8, admit: false, decision: 'stop' } },
      { admission: { running: 1, cap: 9, claim_limit: 8, admit: false, decision: 'stop' }, launched_this_tick: ['RQ-1', 'RQ-2', 'RQ-3', 'RQ-4', 'RQ-5', 'RQ-6', 'RQ-7', 'RQ-8'] },
      { admission: { admit: false, decision: 'stop' } },
    ]) {
      const report = currentUnfed(JSON.stringify({ lanes: STOP_LANES, ...extra }), TWO_WAITING);
      expect(report.fleetStop).toBe('global_admission');
      expect(report.resources.find(r => r.lane === 'a')!.blocked).toEqual({ global_admission: 2 });
    }
  });

  it('leaves per-lane derivation alone when the tick admitted work', () => {
    const status = JSON.stringify({
      lanes: STOP_LANES,
      admission: { running: 1, cap: 9, claim_limit: 8, admit: true, decision: 'admit', gate_reason: null },
      launched_this_tick: ['RQ-1'],
    });
    const report = currentUnfed(status, TWO_WAITING);
    expect(report.fleetStop).toBeNull();
    expect(report.resources.find(r => r.lane === 'a')!.blocked).toEqual({});
  });

  it('reads the stop code back from dispatcher-published blocked reasons', () => {
    const status = JSON.stringify({
      lanes: STOP_LANES,
      unfed_capacity: {
        waiting: 2,
        lanes: {
          a: { waiting_elsewhere: 2, blocked: { admission_stopped: 2 } },
          b: { waiting_elsewhere: 0, blocked: {} },
        },
      },
    });
    const report = currentUnfed(status, TWO_WAITING);
    expect(report.source).toBe('dispatcher');
    expect(report.fleetStop).toBe('admission_stopped');
  });

  it('prints the fleet stop line in text output', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({ lanes: STOP_LANES, paused: 'hold' }));
    writeFileSync(join(dir, 'queue', 'ready.tsv'), TWO_WAITING);
    const result = await run([]);
    expect(result.code).toBe(1);
    expect(result.lines).toContain('a  0/2 running (0%), 0 hinted here  UNFED: 2 free, 2 rows waiting elsewhere (admission_stopped 2)');
    expect(result.lines.join('\n')).toContain('Fleet admission stopped (pause, disk guard or load gate)');
    expect(result.lines.join('\n')).toContain('status.json admission verdict');
  });
});
