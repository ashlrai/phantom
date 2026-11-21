import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdQueueAutofill } from '../src/cli/queue-autofill.js';
import {
  AUTOFILL_EVENT_SCHEMA, AUTOFILL_STATUS_SCHEMA, autofillLaneLines, readAutofillEvents, runAutofillTick, type AutofillTickOptions, type LaneSnapshotView,
} from '../src/core/fleet/autofill-run.js';
import { QueueStore } from '../src/core/queue/store.js';

const NOW = Date.parse('2026-11-19T15:00:00Z');
// Six open roadmap items with words no command or doc uses, so every one is a new bet.
const ITEMS = ['quantum harmonizer', 'plasma kettle', 'cobalt walrus', 'amber lantern', 'velvet compass', 'copper meadow'];

let runsDir = '';
let root = '';
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'autofill-tick-'));
  mkdirSync(join(runsDir, 'queue'));
  root = mkdtempSync(join(tmpdir(), 'autofill-root-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'package.json'), '{"name":"@ashlr/phantom"}');
  writeFileSync(join(root, 'docs', 'ROADMAP-FIXTURE.md'), ITEMS.map(i => `- [ ] ${i} scheduler\n`).join(''));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(runsDir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });

const view = (lanes: Record<string, number>): LaneSnapshotView => ({
  lanes: Object.entries(lanes).map(([lane, queued]) => ({ lane, running: 0, target: 6, queued, held: false, remainingPct: 68 })),
});
const tick = (lanes: Record<string, number>, extra: Partial<AutofillTickOptions> = {}, apply = true) =>
  runAutofillTick({ runsDir, apply, now: () => NOW, root, entries: [], readLanes: async () => view(lanes), readOff: async () => false, ...extra });
const queued = async () => (await new QueueStore(join(runsDir, 'queue')).read()).jobs;

describe('autofill tick', () => {
  it('fills a starved lane up to the per-lane cap and records one event', async () => {
    const report = await tick({ claude: 0 });
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({ schema: AUTOFILL_EVENT_SCHEMA, lane: 'claude', drafted: 4, applied: 4, ts: new Date(NOW).toISOString() });
    expect(report.runs[0]!.skipped).toBeGreaterThanOrEqual(2); // the two bets over the cap
    expect((await queued()).filter(j => j.pool === 'claude')).toHaveLength(4);
    expect(readAutofillEvents(runsDir)).toEqual(report.runs);
    expect(readFileSync(join(runsDir, 'queue', 'dispatch-events.log'), 'utf8')).toMatch(/ AUTOFILL \{.*\} src=autofill\n$/);
  });

  it('does not call a lane with six rows already queued starved', async () => {
    const report = await tick({ claude: 6 });
    expect(report.runs).toEqual([]);
    expect(report.lanes).toEqual([{ lane: 'claude', starved: false, fed: 0, why: '6 ready rows are already queued for it' }]);
    expect(await queued()).toHaveLength(0);
  });

  it('skips with "hourly cap" once the lane has used its 4 this hour', async () => {
    await tick({ claude: 0 });
    const report = await tick({ claude: 0 }, { now: () => NOW + 60_000 });
    expect(report.runs[0]).toMatchObject({ lane: 'claude', drafted: 0, applied: 0, reason: 'hourly cap' });
    expect((await queued()).length).toBe(4);
    // An hour later the cap has rolled off.
    const later = await tick({ claude: 0 }, { now: () => NOW + 61 * 60_000 });
    expect(later.runs[0]!.applied).toBeGreaterThan(0);
  });

  it('stops at 12 across lanes', async () => {
    const lanes = { alpha: 0, bravo: 0, charlie: 0, delta: 0 };
    const report = await tick(lanes, { fill: async o => ({
      schema: 'queue.autofill.v1', lane: o.lane, min: 6, ...o.counts, applied: true, summary: 'ok', skipped: [],
      drafted: Array.from({ length: o.limit ?? 0 }, (_, i) => ({ id: `RQ-${o.lane}${i}`, repo: 'phantom', tier: 'work', goal: 'g', acceptance: 'a', why: 'w' })),
    }) });
    expect(report.runs.map(r => r.applied)).toEqual([4, 4, 4, 0]);
    expect(report.runs[3]!.reason).toBe('hourly cap');
  });

  it('skips with "autofill off" when the kill switch is on', async () => {
    const report = await tick({ claude: 0 }, { readOff: async () => true });
    expect(report.runs[0]).toMatchObject({ drafted: 0, applied: 0, reason: 'autofill off' });
    expect(await queued()).toHaveLength(0);
  });

  it('treats an unreadable kill switch as unknown and does not fill', async () => {
    const report = await tick({ claude: 0 }, { readOff: async () => null });
    expect(report.runs[0]).toMatchObject({ applied: 0, reason: 'autofill state unknown' });
  });

  it('reads the real live config for the kill switch', async () => {
    writeFileSync(join(runsDir, 'queue', 'live-config.json'), JSON.stringify({ v: 1, last_change_by: 'test', overrides: { 'autofill.off': { value: 1, by: 'test', at: '2026-11-19T14:00:00Z', reason: 'test' } } }));
    const report = await tick({ claude: 0 }, { readOff: undefined });
    expect(report.runs[0]!.reason).toBe('autofill off');
  });

  it('is a dry run without apply: nothing queued, nothing recorded', async () => {
    const report = await tick({ claude: 0 }, {}, false);
    expect(report.mode).toBe('dry-run');
    expect(report.runs[0]).toMatchObject({ drafted: 4, applied: 0 });
    expect(await queued()).toHaveLength(0);
    expect(readAutofillEvents(runsDir)).toEqual([]);
  });

  it('shows an unreadable lane snapshot as unknown', async () => {
    const report = await tick({}, { readLanes: async () => null });
    expect(report).toMatchObject({ runs: [], reason: 'Lane snapshot is unknown.' });
  });

  it('records a repeated refusal once per hour', async () => {
    await tick({ claude: 0 }, { readOff: async () => true });
    await tick({ claude: 0 }, { readOff: async () => true, now: () => NOW + 300_000 });
    expect(readAutofillEvents(runsDir)).toHaveLength(1);
  });
});

// Lane rows shaped like queue/status.json (lanes.<lane>.{running,target,queued,held}) joined with each pool's percent used.
const STATUS_LANES = {
  claude: { running: 2, target: 8, queued: 0, held: false },
  'codex-personal': { running: 0, target: 1, queued: 10, held: false },
  devin: { running: 1, target: 0, queued: 0, held: true },
  'codex-local': { running: 7, target: 7, queued: 0, held: false },
  zai: { running: 0, target: 1, queued: 0, held: false },
};
const POOL_PERCENT_USED: Record<string, number> = { claude: 32, 'codex-personal': 100, devin: 10, 'codex-local': 40, zai: 100 };
const fromStatus = async (): Promise<LaneSnapshotView> => ({
  lanes: Object.entries(STATUS_LANES).map(([lane, row]) => ({ lane, ...row, remainingPct: 100 - POOL_PERCENT_USED[lane]! })),
});

describe('autofill picks starved lanes from the status facts', () => {
  it('feeds an idle lane with usage left, leaves the rest alone, and says why', async () => {
    const report = await runAutofillTick({ runsDir, apply: true, now: () => NOW, root, entries: [], readLanes: fromStatus, readOff: async () => false });
    expect(report.runs.map(r => r.lane)).toEqual(['claude']);
    // Capped at the free slots (8 - 2 = 6) and the hourly lane cap (4).
    expect(report.runs[0]).toMatchObject({ lane: 'claude', applied: 4 });
    expect(report.lanes).toEqual([
      { lane: 'claude', starved: true, fed: 4, why: 'running 2 of 8, 0 queued, pool 32% used' },
      { lane: 'codex-local', starved: false, fed: 0, why: 'full: 7 of 7 running' },
      { lane: 'codex-personal', starved: false, fed: 0, why: 'out of usage (pool 100% used)' },
      { lane: 'devin', starved: false, fed: 0, why: 'held, so it is skipped' },
      { lane: 'zai', starved: false, fed: 0, why: 'out of usage (pool 100% used)' },
    ]);
    expect((await queued()).every(j => j.pool === 'claude')).toBe(true);
  });

  it('does not feed a lane whose pool is fully used, even with free slots and nothing queued', async () => {
    const report = await tick({}, { readLanes: async () => ({ lanes: [{ lane: 'codex-personal', running: 0, target: 1, queued: 0, held: false, remainingPct: 0 }] }) });
    expect(report.runs).toEqual([]);
    expect(report.reason).toBe('No lane is starved: codex-personal out of usage (pool 100% used).');
  });

  it('feeds no more than the free slots', async () => {
    const report = await tick({}, { readLanes: async () => ({ lanes: [{ lane: 'claude', running: 5, target: 7, queued: 0, held: false, remainingPct: null }] }) });
    expect(report.runs[0]).toMatchObject({ lane: 'claude', drafted: 2, applied: 2 });
    expect(report.lanes![0]).toMatchObject({ starved: true, fed: 2, why: 'running 5 of 7, 0 queued' });
  });

  it('skips a held lane with the reason in the report', async () => {
    const report = await tick({}, { readLanes: async () => ({ lanes: [{ lane: 'devin', running: 0, target: 3, queued: 0, held: true, remainingPct: 90 }] }) });
    expect(report.runs).toEqual([]);
    expect(report.lanes).toEqual([{ lane: 'devin', starved: false, fed: 0, why: 'held, so it is skipped' }]);
  });

  it('says why a starved lane was not fed when autofill is off', async () => {
    const report = await runAutofillTick({ runsDir, apply: true, now: () => NOW, root, entries: [], readLanes: fromStatus, readOff: async () => true });
    expect(report.lanes!.find(r => r.lane === 'claude')).toEqual({ lane: 'claude', starved: true, fed: 0, why: 'autofill off' });
    expect(autofillLaneLines(report.lanes!)[0]).toBe('claude: starved, fed 0 (autofill off)');
  });
});

describe('phm queue autofill --status', () => {
  it('prints last runs and the remaining cap as typed JSON', async () => {
    await tick({ claude: 0 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdQueueAutofill(['--status', '--json', '--runs-dir', runsDir], { now: () => NOW + 1000 })).toBe(0);
    const status = JSON.parse(String(log.mock.calls[0]![0]));
    expect(status).toMatchObject({ schema: AUTOFILL_STATUS_SCHEMA, off: false, cap: { per_lane: 4, total: 12, used: 4, remaining: 8, lanes: { claude: { used: 4, remaining: 0 } } } });
    expect(status.last_runs).toHaveLength(1);
    expect(status.last_runs[0]).toMatchObject({ lane: 'claude', applied: 4 });
  });

  it('reports a full cap and no runs on a fresh runs dir, in plain words', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdQueueAutofill(['--status', '--runs-dir', runsDir])).toBe(0);
    const text = String(log.mock.calls[0]![0]);
    expect(text).toContain('0 of 12 bets applied');
    expect(text).toContain('No autofill runs recorded.');
  });

  it('refuses --status with a lane', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdQueueAutofill(['--status', '--lane', 'claude'])).toBe(2);
  });
});

describe('autofill tick gap harvest', () => {
  const gapsReport = { schema: 'jobs.gaps.v1', sinceHours: 24, known: true, unknownSources: [], jobsScanned: 1, jobsWithoutGaps: [], candidates: [{ title: 'a', repo: 'phantom', sourceJob: 'J', why: 'w' }], dropped: [], proposed: [{ title: 'a', repo: 'phantom', sourceJob: 'J', why: 'w', jobId: 'GAPX', queued: true, skipped: null }] } as never;
  it('calls the gap harvest once for several starved lanes and reports it', async () => {
    const harvestGaps = vi.fn(async () => gapsReport);
    const report = await tick({ claude: 0, devin: 0 }, { harvestGaps });
    expect(harvestGaps).toHaveBeenCalledTimes(1);
    expect(report.schema).toBe('queue.autofill.tick.v1');
    expect(report.gaps).toEqual({ candidates: 1, queued: 1, skipped: 0, unknown: false });
  });
  it('harvests on every apply tick, even with no starved lane', async () => {
    const harvestGaps = vi.fn(async () => gapsReport);
    const report = await tick({}, { harvestGaps, lastGapQueuedMs: async () => null });
    expect(harvestGaps).toHaveBeenCalledTimes(1);
    expect(report.reason).toBe('No lane is starved.');
    expect(report.gaps).toEqual({ candidates: 1, queued: 1, skipped: 0, unknown: false });
    expect(report.gapsNote).toBeNull();
  });
  it('never writes on a dry run and says why', async () => {
    const harvestGaps = vi.fn(async () => gapsReport);
    const report = await tick({ claude: 0 }, { harvestGaps }, false);
    expect(harvestGaps).not.toHaveBeenCalled();
    expect(report.gapsNote).toBe('dry run: the gap harvest only runs with apply');
  });
  it('names autofill off as the reason', async () => {
    const harvestGaps = vi.fn(async () => gapsReport);
    const report = await tick({ claude: 0 }, { harvestGaps, readOff: async () => true });
    expect(harvestGaps).not.toHaveBeenCalled();
    expect(report.gapsNote).toBe('autofill is off, so no gap harvest');
  });
  it('a tick inside the rate limit records how long ago the last queue was', async () => {
    const harvestGaps = vi.fn(async () => gapsReport);
    const report = await tick({ claude: 0 }, { harvestGaps, lastGapQueuedMs: async () => NOW - 4 * 60_000 });
    expect(harvestGaps).not.toHaveBeenCalled();
    expect(report.gapsNote).toBe('ran 4 min ago (waits 10 min)');
  });
  it('says so when no gap source was readable or no gap was found; a failed harvest never fails the tick', async () => {
    const empty = { ...(gapsReport as object), candidates: [], proposed: [], known: false, unknownSources: ['published jobs'] } as never;
    const unreadable = await tick({ claude: 0 }, { harvestGaps: async () => empty, lastGapQueuedMs: async () => null });
    expect(unreadable.gapsNote).toBe('no gap source readable: published jobs');
    const failing = await tick({ claude: 0 }, { harvestGaps: async () => { throw new Error('boom'); }, lastGapQueuedMs: async () => null });
    expect(failing.gaps).toBeNull();
    expect(failing.gapsNote).toBe('the gap harvest failed: boom');
    expect(failing.runs).toHaveLength(1);
  });
});
