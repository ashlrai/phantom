import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdQueueAutofill } from '../src/cli/queue-autofill.js';
import {
  AUTOFILL_EVENT_SCHEMA, AUTOFILL_STATUS_SCHEMA, readAutofillEvents, runAutofillTick, type AutofillTickOptions, type LaneSnapshotView,
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
  starved: Object.keys(lanes),
  counts: Object.fromEntries(Object.entries(lanes).map(([lane, queued]) => [lane, { running: 0, target: 6, queued }])),
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

  it('does nothing for a full lane', async () => {
    const report = await tick({ claude: 6 });
    expect(report.runs[0]).toMatchObject({ drafted: 0, applied: 0, reason: 'Lane is full.' });
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
