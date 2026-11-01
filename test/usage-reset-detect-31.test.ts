import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { detectUsageResets, readUsageResets } from '../src/core/fleet/usage-reset-detect.js';
import type { LaneTargetRow } from '../src/core/fleet/runs-lane-targets.js';
import type { ResourceLaneRow } from '../src/core/fleet/runs-resource-ledger.js';

const nowMs = Date.parse('2026-10-31T17:00:00-04:00');
const asOf = '2026-10-31T16:20:00-04:00';
const lane: LaneTargetRow = { lane: 'codex-personal', target: 1, floor: 0, ceiling: 2, pausedFrom: null,
  held: true, heldReason: 'autobackoff codex_usage_limit job=fake until=2026-10-31T20:02:15-04:00 src=outcome_unreadable',
  heldUntil: '2026-10-31T20:02:15-04:00', lastChange: '2026-10-31T14:02:00-04:00', changedBy: 'autobackoff' };
const reading: ResourceLaneRow = { lane: lane.lane, running: 0, target: 1, held: true, window: 'weekly', usedPct: 0,
  creditsRemaining: null, resetAt: null, burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null,
  source: 'codex-personal-sessions', deadSignal: null, observation: { source: 'codex-personal-sessions', asOf } };
const cases: [string, Partial<LaneTargetRow>, Partial<ResourceLaneRow> | null, string, boolean][] = [
  ['live reset', {}, {}, 'reset-detected', true],
  ['old observation', {}, { observation: { source: 'codex-personal-sessions', asOf: lane.lastChange! } }, 'stale-reading', false],
  ['high usage', {}, { usedPct: 97 }, 'consistent', false],
  ['expired hold', { heldUntil: asOf }, { usedPct: 97 }, 'hold-expired', true],
  ['manual hold', { heldReason: 'Mason t1221u usage hold', changedBy: 'Mason' }, {}, 'manual-hold', false],
  ['expired manual hold', { heldReason: 'Mason t1221u', heldUntil: asOf }, {}, 'manual-hold', false],
  ['open lane', { held: false }, {}, 'open', false],
  ['missing reading', {}, null, 'no-reading', false],
  ['future observation', {}, { observation: { source: 'codex-personal-sessions', asOf: '2026-11-01T00:00:00Z' } }, 'no-reading', false],
  ['invalid usage', {}, { usedPct: Infinity }, 'no-reading', false],
  ['threshold', {}, { usedPct: 25 }, 'reset-detected', true],
  ['above threshold', {}, { usedPct: 25.1 }, 'consistent', false],
  ['negative usage clamped', {}, { usedPct: -1 }, 'reset-detected', true],
  ['unknown hold time', { lastChange: null }, {}, 'stale-reading', false],
  ['ledger timestamp fallback', {}, { observation: undefined }, 'reset-detected', true],
];
it.each(cases)('%s', (_name, change, usage, state, releasable) => {
  const [row] = detectUsageResets({ lanes: [{ ...lane, ...change }], ledger: usage === null ? [] : [{ ...reading, ...usage }], ledgerAsOf: asOf, nowMs });
  expect(row).toMatchObject({ state, releasable });
  expect(row.tell).not.toContain('/');
  if (state === 'manual-hold') expect(row.heldBy).toBe('manual');
  if (_name === 'negative usage clamped') expect(row.usedPct).toBe(0);
  if (_name === 'future observation') expect(row).toMatchObject({ usedPct: null, readingAsOf: null });
});
it('composes dispatcher slots and status and reports missing sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-reset-'));
  try {
    await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'queue/slots.json'), JSON.stringify({ claude: { target: 1, floor: 0, ceiling: 2, held: true,
      held_reason: lane.heldReason, held_until: lane.heldUntil, held_by: 'autobackoff', last_change: Date.parse(lane.lastChange!) / 1000 } }));
    await writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick: asOf, lanes: { claude: { held: true } }, budget: { claude: { weekly_used_pct: 0 } } }));
    expect(await readUsageResets({ runsDir: root, now: () => nowMs })).toMatchObject({ v: 1, sourceState: 'healthy', rows: [{ lane: 'claude', state: 'reset-detected', releasable: true }] });
    await writeFile(join(root, 'queue/status.json'), '{');
    expect(await readUsageResets({ runsDir: root, now: () => nowMs })).toMatchObject({ sourceState: 'degraded' });
    expect(await readUsageResets({ runsDir: join(root, 'missing'), now: () => nowMs })).toMatchObject({ sourceState: 'missing', rows: [] });
    expect(await readUsageResets({ now: () => { throw new Error('fake clock failure'); } })).toMatchObject({ sourceState: 'degraded', rows: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
