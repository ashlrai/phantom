import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetUnfed } from '../src/cli/fleet-unfed.js';
import { currentUnfed, foldClaimOverrides, foldDecisionOutcomes, foldMarketOverrides, foldRouteRejections, foldUnfedHistory, readyHints, renderUnfed } from '../src/core/fleet/unfed-capacity.js';

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
const decisionRow = (job: string, ts: number, override: unknown = { from: 'codex-personal', to: 'claude', reason: 'preferred_lane_fallback' }) =>
  JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job, ts, chosen_lane: 'claude', preferred_lane: 'codex-personal', override });

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

  it.each(['derived', 'dispatcher'] as const)('caps %s headroom at the configured target', (source) => {
    const lanes = { a: { running: 2, target: 2, effective_target: 4 } };
    const unfed_capacity = source === 'dispatcher'
      ? { waiting: 1, lanes: { a: { waiting_elsewhere: 1 } } }
      : undefined;
    const report = currentUnfed(JSON.stringify({ lanes, unfed_capacity }), row('RQ-A', 'elsewhere'));

    expect(report).toMatchObject({ source, unfedLanes: [], unfedSlots: 0 });
    expect(report.resources[0]).toMatchObject({ target: 2, headroom: 0, utilization: 1, unfed: false });
  });

  it('rejects a lane whose configured target is missing even when an effective target is present', () => {
    const status = JSON.stringify({ lanes: { a: { running: 0, effective_target: 2 } } });
    expect(() => currentUnfed(status, '')).toThrow('invalid lane');
  });

  it.each([
    { configured: 1, target: 1, headroom: 0 },
    { configured: 3, target: 3, headroom: 2 },
    { configured: 6, target: 4, headroom: 3 },
    { configured: -1, target: 4, headroom: 3 },
    { configured: undefined, target: 4, headroom: 3 },
  ])('bounds derived unfed capacity with slots.json target $configured', ({ configured, target, headroom }) => {
    const slots = JSON.stringify({ 'codex-cmp': { target: configured } });
    const report = currentUnfed(JSON.stringify({ lanes: LANES }), READY, { slots });

    expect(report.unfedSlots).toBe(headroom);
    expect(report.resources.find(r => r.lane === 'codex-cmp')).toMatchObject({
      target, headroom, unfed: headroom > 0,
    });
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
    const report = currentUnfed(status, READY, { slots: JSON.stringify({ 'codex-cmp': { target: 0 } }) });
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

  it.each([
    { slots: JSON.stringify({ 'codex-cmp': { held: true } }) },
    { hold: 'codex-cmp', slots: '{}' },
    { hold: 'codex-cmp', slots: 'unreadable' },
  ])('excludes configured holds from derived unfed capacity (%j)', market => {
    const status = JSON.stringify({ lanes: LANES });
    for (const ready of [READY, null]) {
      const report = currentUnfed(status, ready, market);
      expect(report).toMatchObject({ unfedLanes: [], unfedSlots: 0 });
      expect(report.resources.find(r => r.lane === 'codex-cmp')).toMatchObject({
        held: true, headroom: 3, unfed: false, waitingElsewhere: 0, blocked: {},
      });
    }
  });

  it.each([undefined, { waiting_elsewhere: -1 }])(
    'keeps an idle lane unknown when its published count is unavailable (%j)',
    (entry) => {
      const lanes = { a: { running: 0, target: 2 }, b: { running: 0, target: 2 } };
      const unfed_capacity = { waiting: 2, lanes: { a: { waiting_elsewhere: 1 }, b: entry } };
      const report = currentUnfed(JSON.stringify({ lanes, unfed_capacity }), '');
      expect(report).toMatchObject({ waiting: 2, unfedLanes: ['a'], unfedSlots: null });
      expect(report.resources[1]).toMatchObject({ lane: 'b', readyHinted: 0, waitingElsewhere: null, unfed: null });
    },
  );

  it('distinguishes a missing dispatcher total from a measured empty tick', () => {
    const lanes = { a: { running: 0, target: 2 } };
    const ready = row('RQ-A', 'elsewhere');
    const partial = currentUnfed(JSON.stringify({ lanes, unfed_capacity: { lanes: {} } }), ready);
    expect(partial).toMatchObject({ waiting: null, unfedSlots: null });
    expect(partial.resources[0]).toMatchObject({ waitingElsewhere: null, unfed: null });

    const empty = currentUnfed(JSON.stringify({ lanes, unfed_capacity: { waiting: 0, lanes: {} } }), ready);
    expect(empty).toMatchObject({ waiting: 0, unfedSlots: 0 });
    expect(empty.resources[0]).toMatchObject({ waitingElsewhere: 0, unfed: false });
  });

  it.each(['derived', 'dispatcher'] as const)('bounds %s unfed slots by the shared waiting count', (source) => {
    const lanes = { a: { running: 0, target: 2 }, b: { running: 0, target: 2 } };
    const entry = { waiting_elsewhere: 1, blocked: { missing_capability: 1 } };
    const unfed_capacity = source === 'dispatcher' ? { waiting: 1, lanes: { a: entry, b: entry } } : undefined;
    const report = currentUnfed(JSON.stringify({ lanes, unfed_capacity }), row('RQ-A', 'elsewhere'));
    expect(report).toMatchObject({ source, waiting: 1, unfedLanes: ['a', 'b'], unfedSlots: 1 });
    expect(report.resources.map(r => r.waitingElsewhere)).toEqual([1, 1]);
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
  it('uses an inclusive trailing window and excludes even slightly future ticks', () => {
    const lanes = { claude: { unfed: true, headroom: 2, waiting_elsewhere: 1 } };
    const start = t - 3600;
    const text = [start - 1, start, t, t + 1].map(ts => unfedRow(ts, lanes)).join('\n');

    expect(foldUnfedHistory(text, now, 1)).toMatchObject({
      ticks: 2,
      lanes: [{ lane: 'claude', unfedTicks: 2, slotTicks: 2, lastUnfedAt: new Date(now).toISOString() }],
    });
  });

  it('says when there is no history file', () => {
    expect(foldUnfedHistory(null, now, 24)).toEqual({ windowHours: 24, available: false, ticks: 0, lanes: [] });
    expect(foldUnfedHistory('', now, 24)).toEqual({ windowHours: 24, available: true, ticks: 0, lanes: [] });
  });

  it('counts a replayed tick once and uses the last usable snapshot as a whole', () => {
    const codex = { unfed: true, headroom: 3, waiting_elsewhere: 3 };
    const claude = { unfed: true, headroom: 2, waiting_elsewhere: 1, blocked: { missing_capability: 1 } };
    const replay = unfedRow(t, { claude });
    const text = [
      unfedRow(t, { codex }),
      replay,
      unfedRow(t - 60, { codex }),
      replay,
      unfedRow(t, { codex: { ...codex, headroom: 0 } }),
    ].join('\n');

    expect(foldUnfedHistory(text, now, 1)).toMatchObject({
      ticks: 2,
      lanes: [
        { lane: 'codex', unfedTicks: 1, slotTicks: 3, lastUnfedAt: new Date(now - 60_000).toISOString(), blocked: {} },
        { lane: 'claude', unfedTicks: 1, slotTicks: 1, lastUnfedAt: new Date(now).toISOString(), blocked: { missing_capability: 1 } },
      ],
    });
  });

  it('counts only lanes with both spare slots and waiting work', () => {
    const full = { unfed: true, headroom: 0, waiting_elsewhere: 2, blocked: { saturated: 2 } };
    const idle = { unfed: true, headroom: 2, waiting_elsewhere: 0 };
    const starved = { unfed: true, headroom: 2, waiting_elsewhere: 1 };
    const text = [
      unfedRow(t - 60, { codex: starved }),
      unfedRow(t - 30, { codex: full, claude: idle }),
      unfedRow(t, { codex: full, claude: starved }),
    ].join('\n');

    expect(foldUnfedHistory(text, now, 24)).toMatchObject({
      ticks: 2,
      lanes: [
        { lane: 'claude', unfedTicks: 1, slotTicks: 1, lastUnfedAt: new Date(now).toISOString(), blocked: {} },
        { lane: 'codex', unfedTicks: 1, slotTicks: 1, lastUnfedAt: new Date(now - 60_000).toISOString(), blocked: {} },
      ],
    });
  });
});

describe('foldMarketOverrides', () => {
  const now = 1_800_000_000_000;
  const t = now / 1000;
  it('keeps the latest decision as of the report time across all decision folds', () => {
    const text = [
      decision('RQ-A', t - 24 * 3600),
      decision('RQ-B', t),
      decision('RQ-B', t + 1, { chosen_lane: null, override: null }),
      decision('RQ-C', t + 1),
    ].join('\n');

    expect(foldMarketOverrides(text, now, 24)).toMatchObject({ decided: 2, overridden: 2 });
    expect(foldRouteRejections(text, now, 24)).toMatchObject({ decided: 2, unrouted: 0 });
    expect(foldDecisionOutcomes(text, null, now, 24)).toMatchObject({
      decided: 2, overridden: { decided: 2 }, unrouted: { decided: 0 },
    });
  });

  it('requires recorded lane fields across all decision folds', () => {
    const text = [
      decision('RQ-A', t - 90),
      decision('RQ-A', t - 30, { chosen_lane: undefined }),
      decision('RQ-B', t - 30, { preferred_lane: undefined }),
      decision('RQ-C', t - 30, { chosen_lane: 'invalid lane' }),
      decision('RQ-D', t - 30, { preferred_lane: false }),
      decision('RQ-E', t - 30, { preferred_lane: null, override: null }),
      decision('RQ-F', t - 30, { chosen_lane: null, override: null }),
    ].join('\n');

    expect(foldMarketOverrides(text, now, 24)).toMatchObject({ decided: 3, overridden: 1 });
    expect(foldRouteRejections(text, now, 24)).toMatchObject({ decided: 3, unrouted: 1 });
    expect(foldDecisionOutcomes(text, null, now, 24)).toMatchObject({
      decided: 3, overridden: { decided: 1 }, open: { decided: 1 }, unrouted: { decided: 1 },
    });
  });

  it('uses the last valid journal entry for decisions from the same tick', () => {
    const text = [
      decision('RQ-A', t, {
        chosen_lane: null, preferred_lane: undefined, override: null,
        reason_codes: ['invalid_requirements'],
      }),
      decision('RQ-A', t, {
        rejected_lanes: [{ lane: 'codex-personal', reason_codes: ['saturated'] }],
      }),
      decision('RQ-A', t, { chosen_lane: undefined }),
      decision('RQ-A', t - 1, { chosen_lane: null, override: null }),
    ].join('\n');

    expect(foldMarketOverrides(text, now, 24)).toMatchObject({ decided: 1, overridden: 1 });
    expect(foldRouteRejections(text, now, 24)).toMatchObject({
      decided: 1, unrouted: 0, byReason: { saturated: 1 },
    });
    expect(foldDecisionOutcomes(text, null, now, 24)).toMatchObject({
      decided: 1, overridden: { decided: 1 }, unrouted: { decided: 0 },
    });
  });
  const decision = (job: string, ts: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: 'work-market.v1', event: 'route_decision', job, ts,
      chosen_lane: 'claude', preferred_lane: 'codex-personal',
      override: { from: 'codex-personal', to: 'claude', reason: 'preferred_lane_fallback', preferred_lane_blocked_by: ['saturated'] },
      ...extra,
    });

  it('lets a dispatcher requirements failure supersede an earlier route without guessing a preference', () => {
    const invalid = (job: string) => JSON.stringify({
      schema: 'work-market.v1', event: 'route_decision', job, ts: t - 30,
      chosen_lane: null, rejected_lanes: [], reason_codes: ['invalid_requirements'],
    });
    const text = [
      invalid('RQ-A'),
      decision('RQ-A', t - 90, { rejected_lanes: [{ lane: 'devin', reason_codes: ['saturated'] }] }),
      invalid('RQ-B'),
    ].join('\n');

    expect(foldMarketOverrides(text, now, 24)).toMatchObject({ decided: 2, overridden: 0 });
    expect(foldRouteRejections(text, now, 24)).toMatchObject({ decided: 2, unrouted: 2, lanes: [], byReason: {} });
    expect(foldDecisionOutcomes(text, null, now, 24)).toMatchObject({
      decided: 2, overridden: { decided: 0 }, open: { decided: 0 }, unrouted: { decided: 2 },
    });
  });

  it("collapses route decisions to each job's latest in-window decision", () => {
    const journal = [
      // Same job decided twice: only the latest counts, and it ran on-hint.
      decision('RQ-A', t - 300),
      decision('RQ-A', t - 60, { override: null, chosen_lane: 'codex-personal' }),
      decision('RQ-B', t - 120),
      decision('RQ-B', t - 30, { chosen_lane: 'devin', override: { from: 'codex-personal', to: 'devin', reason: 'resource_fit' } }),
      decision('RQ-C', t - 90, { chosen_lane: null, override: null, reason_codes: ['no_runnable_lane'] }),
      // Out-of-window, future, missing-ts, malformed and non-decision rows never count.
      decision('RQ-D', t - 25 * 3600),
      decision('RQ-E', t + 3600),
      JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job: 'RQ-F' }),
      '{"event":"route_decision" broken',
      unfedRow(t - 60, {}),
      // Overrides with malformed lane or reason fields are not counted.
      decision('RQ-G', t - 40, { override: { from: 'bad lane!', to: 'claude', reason: 'preferred_lane_fallback' } }),
      decision('RQ-H', t - 40, { override: { from: 'codex-personal', to: 'claude', reason: 'NOT_A_CODE' } }),
    ].join('\n');
    expect(foldMarketOverrides(journal, now, 24)).toEqual({
      available: true,
      decided: 5, // RQ-A, RQ-B, RQ-C, RQ-G, RQ-H
      overridden: 1, // only RQ-B's latest decision left its hint with a valid override
      byReason: { resource_fit: 1 },
      lanes: [{ from: 'codex-personal', to: 'devin', reason: 'resource_fit', jobs: 1 }],
    });
  });

  it('tallies overrides by reason and hinted->chosen lane, largest first', () => {
    const journal = [
      decision('RQ-A', t - 100),
      decision('RQ-B', t - 90),
      decision('RQ-C', t - 80, { chosen_lane: 'devin', override: { from: 'codex-personal', to: 'devin', reason: 'resource_fit' } }),
      decision('RQ-D', t - 70, { preferred_lane: 'claude', chosen_lane: 'codex-cmp', override: { from: 'claude', to: 'codex-cmp', reason: 'preferred_lane_fallback' } }),
    ].join('\n');
    const tally = foldMarketOverrides(journal, now, 24);
    expect(tally.decided).toBe(4);
    expect(tally.overridden).toBe(4);
    expect(tally.byReason).toEqual({ preferred_lane_fallback: 3, resource_fit: 1 });
    expect(tally.lanes).toEqual([
      { from: 'codex-personal', to: 'claude', reason: 'preferred_lane_fallback', jobs: 2 },
      { from: 'claude', to: 'codex-cmp', reason: 'preferred_lane_fallback', jobs: 1 },
      { from: 'codex-personal', to: 'devin', reason: 'resource_fit', jobs: 1 },
    ]);
  });

  it('counts contradictory override records only as decisions and classifies them by recorded lanes', () => {
    const journal = [
      decision('RQ-A', t - 100),
      decision('RQ-A', t - 50, { chosen_lane: 'devin' }),
      decision('RQ-B', t - 50, { preferred_lane: 'devin' }),
      decision('RQ-C', t - 50, { chosen_lane: null }),
      decision('RQ-D', t - 50, { preferred_lane: null, override: { from: null, to: 'claude', reason: 'resource_fit' } }),
      decision('RQ-E', t - 50, { preferred_lane: 'claude', override: { from: 'claude', to: 'claude', reason: 'resource_fit' } }),
    ].join('\n');
    expect(foldMarketOverrides(journal, now, 24)).toEqual({
      available: true, decided: 5, overridden: 0, byReason: {}, lanes: [],
    });
    const outcomes = foldDecisionOutcomes(journal, null, now, 24);
    expect(outcomes.unexplained.decided).toBe(2);
    expect(outcomes.unrouted.decided).toBe(1);
    expect(outcomes.open.decided).toBe(1);
    expect(outcomes.hinted.decided).toBe(1);
    expect(outcomes.overridden.decided).toBe(0);
  });

  it('says when there is no history file', () => {
    expect(foldMarketOverrides(null, now, 24)).toEqual({ available: false, decided: 0, overridden: 0, byReason: {}, lanes: [] });
    expect(foldMarketOverrides('', now, 24)).toEqual({ available: true, decided: 0, overridden: 0, byReason: {}, lanes: [] });
  });
});

describe('foldClaimOverrides', () => {
  const now = 1_800_000_000_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  // dispatchd stamps jobs.jsonl rows with local time and a %z offset; ISO with Z parses the same way.
  const claim = (job: string, ts: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ event: 'claim', job, repo: 'phantom', lane: 'claude', tier: 'work', ts, ...extra });
  const batchClaim = (job: string, ts: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ event: 'batch_claim', job, batch: 'B-1', repo: 'phantom', lane: 'claude', tier: 'work', ts, ...extra });

  it('includes both report window endpoints and excludes slightly future launches', () => {
    const override = { lane_hint: 'devin', lane_override: 'batch_session' };
    const journal = [
      claim('RQ-A', iso(now - 24 * 3_600_000)),
      batchClaim('RQ-B', iso(now), override),
      batchClaim('RQ-C', iso(now + 1), override),
    ].join('\n');

    expect(foldClaimOverrides(journal, now, 24)).toMatchObject({ claimed: 2, overridden: 1 });
  });

  it('tallies claim launches that left their hinted lane, batch_session included', () => {
    const journal = [
      claim('RQ-A', iso(now - 100_000)),
      claim('RQ-B', iso(now - 90_000), { lane_hint: 'codex-personal', lane_override: 'preferred_lane_fallback' }),
      claim('RQ-B', iso(now - 80_000), { lane_hint: 'codex-personal', lane_override: 'preferred_lane_fallback' }),
      batchClaim('RQ-C', iso(now - 70_000), { lane_hint: 'devin', lane_override: 'batch_session' }),
      batchClaim('RQ-D', iso(now - 60_000), { lane_hint: null, lane_override: 'resource_fit' }),
      claim('RQ-BATCH-1', iso(now - 60_000)),
      // Out-of-window, future, missing-ts, malformed and non-claim rows never count.
      claim('RQ-E', iso(now - 25 * 3_600_000)),
      claim('RQ-F', iso(now + 3_600_000)),
      claim('RQ-G', 'not a date'),
      claim('', iso(now - 50_000), { lane_hint: 'claude', lane_override: 'resource_fit' }),
      claim('RQ-H', iso(now - 50_000), { lane: 'bad lane!', lane_hint: 'claude', lane_override: 'resource_fit' }),
      JSON.stringify({ event: 'finish', job: 'RQ-I', lane: 'claude', ts: iso(now - 40_000), lane_hint: 'devin', lane_override: 'batch_session' }),
      '{"event":"claim" broken',
      // lane_override without a recorded lane_hint, or with a malformed one, cannot name its origin.
      claim('RQ-J', iso(now - 30_000), { lane_override: 'resource_fit' }),
      claim('RQ-K', iso(now - 30_000), { lane_hint: 'bad lane!', lane_override: 'resource_fit' }),
      // An invalid override code is not counted.
      claim('RQ-L', iso(now - 20_000), { lane_hint: 'devin', lane_override: 'NOT_A_CODE' }),
      claim('RQ-M', iso(now - 10_000), { lane_hint: 'claude', lane_override: 'resource_fit' }),
    ].join('\n');
    expect(foldClaimOverrides(journal, now, 24)).toEqual({
      available: true, truncated: false,
      claimed: 9, // RQ-A, RQ-B x2, RQ-C, RQ-D, RQ-J through RQ-M — events, not distinct jobs
      overridden: 4, // RQ-B x2, RQ-C, RQ-D
      byReason: { preferred_lane_fallback: 2, batch_session: 1, resource_fit: 1 },
      lanes: [
        { from: 'codex-personal', to: 'claude', reason: 'preferred_lane_fallback', claims: 2 },
        { from: null, to: 'claude', reason: 'resource_fit', claims: 1 },
        { from: 'devin', to: 'claude', reason: 'batch_session', claims: 1 },
      ],
    });
  });

  it('reads the dispatchd %z timestamp form', () => {
    const journal = claim('RQ-A', '2026-11-20T14:23:45-0500', { lane_hint: 'devin', lane_override: 'batch_session' });
    const at = Date.parse('2026-11-20T19:23:45.000Z');
    expect(foldClaimOverrides(journal, at + 60_000, 24).overridden).toBe(1);
    expect(foldClaimOverrides(journal, at - 25 * 3_600_000, 24).claimed).toBe(0);
  });

  it('marks a tail-truncated ledger as a lower bound', () => {
    const journal = claim('RQ-A', iso(now - 1000));
    expect(foldClaimOverrides(journal, now, 24, true)).toMatchObject({ available: true, truncated: true, claimed: 1 });
    expect(foldClaimOverrides(null, now, 24, true)).toEqual({ available: false, truncated: false, claimed: 0, overridden: 0, byReason: {}, lanes: [] });
    expect(foldClaimOverrides('', now, 24)).toEqual({ available: true, truncated: false, claimed: 0, overridden: 0, byReason: {}, lanes: [] });
  });
});

describe('foldDecisionOutcomes', () => {
  const now = 1_800_000_000_000;
  const t = now / 1000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const decision = (job: string, ts: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: 'work-market.v1', event: 'route_decision', job, ts,
      chosen_lane: 'claude', preferred_lane: 'codex-personal',
      override: { from: 'codex-personal', to: 'claude', reason: 'preferred_lane_fallback' },
      ...extra,
    });
  const outcome = (job: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ event: 'finish', job, phase: 'MERGED', ts: iso(now - 500), ...extra });

  it('joins each decided job to its recorded outcome, grouped by how the hint fared', () => {
    const market = [
      // hinted: chose the declared preferred lane, merged.
      decision('RQ-H', t - 500, { chosen_lane: 'codex-personal', preferred_lane: 'codex-personal', override: null, work_class: 'judgment' }),
      // overridden: left the hint with a recorded reason; merged then reverted.
      decision('RQ-O', t - 400, { work_class: 'standard' }),
      // open: no declared preference; closed without a merge.
      decision('RQ-P', t - 300, { preferred_lane: null, override: null, work_class: 'bulk' }),
      // unrouted: latest decision chose no lane.
      decision('RQ-U', t - 200, { chosen_lane: null, preferred_lane: null, override: null }),
      // unexplained: left a declared preference with no well-formed override record.
      decision('RQ-X', t - 100, { chosen_lane: 'devin', preferred_lane: 'codex-personal', override: null }),
      // decided twice: only the latest in-window decision counts.
      decision('RQ-D', t - 900, { chosen_lane: 'devin', preferred_lane: 'codex-personal', override: { from: 'codex-personal', to: 'devin', reason: 'resource_fit' } }),
      decision('RQ-D', t - 50, { chosen_lane: 'codex-personal', preferred_lane: 'codex-personal', override: null }),
      // Out-of-window and non-decision rows never count.
      decision('RQ-OLD', t - 25 * 3600),
      unfedRow(t - 60, {}),
    ].join('\n');
    const jobs = [
      outcome('RQ-H'),
      outcome('RQ-O', { reverted: true }),
      outcome('RQ-P', { phase: 'CLOSED' }),
      // RQ-U and RQ-X have claim rows but no terminal state: unresolved.
      JSON.stringify({ event: 'claim', job: 'RQ-U', lane: 'claude', ts: iso(now - 400) }),
      JSON.stringify({ event: 'claim', job: 'RQ-X', lane: 'devin', ts: iso(now - 300) }),
      outcome('RQ-D'),
      // A job never decided does not join.
      outcome('RQ-NOPE'),
    ].join('\n');
    const report = foldDecisionOutcomes(market, jobs, now, 24);
    expect(report.available).toBe(true);
    expect(report.jobsAvailable).toBe(true);
    expect(report.jobsTruncated).toBe(false);
    expect(report.decided).toBe(6); // RQ-H, RQ-O, RQ-P, RQ-U, RQ-X, RQ-D
    expect(report.hinted).toEqual({ decided: 2, known: 2, merged: 2, unmerged: 0, reverted: 0, unresolved: 0 });
    expect(report.overridden).toEqual({ decided: 1, known: 1, merged: 1, unmerged: 0, reverted: 1, unresolved: 0 });
    expect(report.open).toEqual({ decided: 1, known: 1, merged: 0, unmerged: 1, reverted: 0, unresolved: 0 });
    expect(report.unrouted).toEqual({ decided: 1, known: 0, merged: 0, unmerged: 0, reverted: 0, unresolved: 1 });
    expect(report.unexplained).toEqual({ decided: 1, known: 0, merged: 0, unmerged: 0, reverted: 0, unresolved: 1 });
    expect(report.byReason).toEqual({ preferred_lane_fallback: 1 });
    expect(report.byClass).toEqual({
      judgment: { decided: 1, known: 1, merged: 1, unmerged: 0, reverted: 0, unresolved: 0 },
      standard: { decided: 1, known: 1, merged: 1, unmerged: 0, reverted: 1, unresolved: 0 },
      bulk: { decided: 1, known: 1, merged: 0, unmerged: 1, reverted: 0, unresolved: 0 },
      unclassified: { decided: 3, known: 1, merged: 1, unmerged: 0, reverted: 0, unresolved: 2 },
    });
  });

  it('keeps unresolved honest when the jobs ledger is absent, empty or truncated', () => {
    const market = decision('RQ-A', t - 100);
    const missing = foldDecisionOutcomes(market, null, now, 24, true);
    expect(missing).toMatchObject({ available: true, jobsAvailable: false, jobsTruncated: false, decided: 1 });
    expect(missing.overridden).toEqual({ decided: 1, known: 0, merged: 0, unmerged: 0, reverted: 0, unresolved: 1 });
    const empty = foldDecisionOutcomes(market, '', now, 24);
    expect(empty.jobsAvailable).toBe(true);
    expect(empty.overridden.unresolved).toBe(1);
    const truncated = foldDecisionOutcomes(market, outcome('RQ-A'), now, 24, true);
    expect(truncated.jobsTruncated).toBe(true);
    expect(truncated.overridden).toMatchObject({ decided: 1, merged: 1 });
  });

  it('uses only merge and revert evidence dated at or before the report time', () => {
    const market = [
      decision('RQ-MERGED', t - 100),
      decision('RQ-FUTURE', t - 100),
      decision('RQ-UNDATED', t - 100),
    ].join('\n');
    const jobs = [
      outcome('RQ-MERGED', { mergedAt: iso(now), reverted: true, revertedAt: iso(now + 1) }),
      outcome('RQ-MERGED', { phase: 'CLOSED', ts: iso(now + 1) }),
      outcome('RQ-FUTURE', { mergedAt: iso(now + 1) }),
      outcome('RQ-UNDATED', { ts: undefined }),
    ].join('\n');

    expect(foldDecisionOutcomes(market, jobs, now, 24).overridden).toEqual({
      decided: 3, known: 1, merged: 1, unmerged: 0, reverted: 0, unresolved: 2,
    });
  });

  it('uses the first parseable verdict stamp while preserving terminal timestamp precedence', () => {
    const market = ['RQ-MERGED', 'RQ-CLOSED', 'RQ-REVERTED', 'RQ-FUTURE']
      .map(job => decision(job, t - 100)).join('\n');
    const jobs = [
      outcome('RQ-MERGED', { mergedAt: 'invalid', ts: iso(now) }),
      outcome('RQ-CLOSED', { phase: 'CLOSED', closedAt: 'invalid', ts: 'invalid', at: iso(now) }),
      outcome('RQ-REVERTED', { reverted: true, reverted_at: 'invalid', revertedAt: iso(now) }),
      outcome('RQ-FUTURE', { mergedAt: iso(now + 1), ts: iso(now) }),
    ].join('\n');

    expect(foldDecisionOutcomes(market, jobs, now, 24).overridden).toEqual({
      decided: 4, known: 3, merged: 2, unmerged: 1, reverted: 1, unresolved: 1,
    });
  });

  it('says when there is no market journal', () => {
    expect(foldDecisionOutcomes(null, outcome('RQ-A'), now, 24)).toMatchObject({
      available: false, jobsAvailable: true, decided: 0,
      hinted: { decided: 0 }, overridden: { decided: 0 }, open: { decided: 0 },
      unrouted: { decided: 0 }, unexplained: { decided: 0 }, byReason: {}, byClass: {},
    });
    expect(foldDecisionOutcomes('', '', now, 24)).toMatchObject({ available: true, jobsAvailable: true, decided: 0 });
  });
});

describe('foldRouteRejections', () => {
  const now = 1_800_000_000_000;
  const t = now / 1000;
  const rejected = (lane: string, ...codes: string[]) => ({ lane, reason_codes: codes });
  const decision = (job: string, ts: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: 'work-market.v1', event: 'route_decision', job, ts,
      chosen_lane: 'claude', preferred_lane: 'codex-personal', override: null,
      ...extra,
    });

  it("collapses to each job's latest decision and tallies rejected lanes by reason", () => {
    const journal = [
      // Same job decided twice: only the latest rejection set counts.
      decision('RQ-A', t - 300, { rejected_lanes: [rejected('devin', 'quota_exhausted')] }),
      decision('RQ-A', t - 60, { rejected_lanes: [rejected('codex-cmp', 'saturated'), rejected('devin', 'quota_exhausted', 'held')] }),
      decision('RQ-B', t - 120, { rejected_lanes: [rejected('codex-cmp', 'missing_capability'), rejected('devin', 'quota_exhausted')] }),
      // An unrouted decision still records why every lane was rejected.
      decision('RQ-C', t - 90, { chosen_lane: null, preferred_lane: null, reason_codes: ['no_runnable_lane'], rejected_lanes: [rejected('codex-cmp', 'held'), rejected('devin', 'provider_backoff')] }),
      // A routed decision with no rejected lanes contributes decided only.
      decision('RQ-D', t - 80, { rejected_lanes: [] }),
      // Out-of-window, future, malformed-ts, broken and non-decision rows never count.
      decision('RQ-OLD', t - 25 * 3600, { rejected_lanes: [rejected('devin', 'quota_exhausted')] }),
      decision('RQ-FUTURE', t + 3600, { rejected_lanes: [rejected('devin', 'quota_exhausted')] }),
      JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job: 'RQ-NOTS' }),
      '{"event":"route_decision" broken',
      unfedRow(t - 60, {}),
    ].join('\n');
    expect(foldRouteRejections(journal, now, 24)).toEqual({
      available: true,
      decided: 4, // RQ-A (latest), RQ-B, RQ-C, RQ-D
      unrouted: 1, // RQ-C
      lanes: [
        { lane: 'codex-cmp', jobs: 3, reasons: { saturated: 1, missing_capability: 1, held: 1 } },
        { lane: 'devin', jobs: 3, reasons: { quota_exhausted: 2, held: 1, provider_backoff: 1 } },
      ],
      // byReason counts each job once per reason across all its rejected lanes:
      // RQ-A contributes saturated+quota_exhausted+held, RQ-B missing_capability+quota_exhausted,
      // RQ-C held+provider_backoff — so quota_exhausted and held each reach 2.
      byReason: { quota_exhausted: 2, held: 2, saturated: 1, missing_capability: 1, provider_backoff: 1 },
    });
  });

  it('counts a job once per reason however many lanes rejected it for that reason', () => {
    const journal = [
      decision('RQ-A', t - 100, { rejected_lanes: [rejected('codex-cmp', 'quota_exhausted'), rejected('devin', 'quota_exhausted'), rejected('omlx', 'local_opt_in_required')] }),
      decision('RQ-B', t - 90, { rejected_lanes: [rejected('devin', 'quota_exhausted')] }),
    ].join('\n');
    const tally = foldRouteRejections(journal, now, 24);
    expect(tally.byReason).toEqual({ quota_exhausted: 2, local_opt_in_required: 1 });
    expect(tally.lanes).toEqual([
      { lane: 'devin', jobs: 2, reasons: { quota_exhausted: 2 } },
      { lane: 'codex-cmp', jobs: 1, reasons: { quota_exhausted: 1 } },
      { lane: 'omlx', jobs: 1, reasons: { local_opt_in_required: 1 } },
    ]);
  });

  it('skips malformed rejected_lanes entries and reason codes, never guessing', () => {
    const journal = [
      decision('RQ-A', t - 100, {
        rejected_lanes: [
          'not-an-object',
          { lane: 'bad lane!', reason_codes: ['quota_exhausted'] },
          { lane: 'omlx' },                                  // no reason_codes array
          { lane: 'omlx', reason_codes: 'quota_exhausted' }, // reason_codes not an array
          { lane: 'claude', reason_codes: ['NOT_A_CODE', 'also bad', 'quota_exhausted'] },
          { lane: 'devin', reason_codes: ['quota_exhausted', 'quota_exhausted'] }, // dup code deduped
          { lane: 'devin', reason_codes: ['saturated'] },    // duplicate lane: first entry wins
        ],
      }),
      // rejected_lanes present but not an array records nothing.
      decision('RQ-B', t - 90, { rejected_lanes: 'quota_exhausted' }),
    ].join('\n');
    expect(foldRouteRejections(journal, now, 24)).toEqual({
      available: true,
      decided: 2,
      unrouted: 0,
      lanes: [
        { lane: 'claude', jobs: 1, reasons: { quota_exhausted: 1 } },
        { lane: 'devin', jobs: 1, reasons: { quota_exhausted: 1 } },
      ],
      // RQ-A hit quota_exhausted on two lanes but counts once; RQ-B recorded none.
      byReason: { quota_exhausted: 1 },
    });
  });

  it('says when there is no market journal', () => {
    expect(foldRouteRejections(null, now, 24)).toEqual({ available: false, decided: 0, unrouted: 0, lanes: [], byReason: {} });
    expect(foldRouteRejections('', now, 24)).toEqual({ available: true, decided: 0, unrouted: 0, lanes: [], byReason: {} });
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

  it.each(['missing', 'unreadable'])('preserves unknown queue counts when ready.tsv is %s', async unavailable => {
    writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({
      schema: 'dispatchd.status.v1', last_tick: new Date().toISOString(), lanes: LANES,
    }));
    const ready = join(dir, 'queue', 'ready.tsv');
    if (unavailable === 'unreadable') mkdirSync(ready);

    const result = await run();
    expect(result.code).toBe(2);
    expect(JSON.parse(result.lines[0]!)).toMatchObject({
      statusFresh: true, waiting: null, invalidRows: null, unfedSlots: null, unfedLanes: [],
      resources: expect.arrayContaining([
        expect.objectContaining({ lane: 'codex-cmp', headroom: 3, readyHinted: null, waitingElsewhere: null, unfed: null }),
        expect.objectContaining({ lane: 'devin', unfed: false }),
      ]),
    });
    vi.restoreAllMocks();
    expect((await run([])).lines.join('\n')).toContain('Unfed capacity unknown: unknown rows waiting.');

    vi.restoreAllMocks();
    rmSync(ready, { recursive: true, force: true });
    writeFileSync(ready, '');
    const empty = await run();
    expect(JSON.parse(empty.lines[0]!)).toMatchObject({ waiting: 0, invalidRows: 0, unfedSlots: 0 });
  });

  it('preserves published unfed counts when ready.tsv is unavailable', () => {
    const report = currentUnfed(JSON.stringify({
      lanes: LANES,
      unfed_capacity: { waiting: 2, lanes: { 'codex-cmp': { waiting_elsewhere: 2 } } },
    }), null);
    expect(report).toMatchObject({
      source: 'dispatcher', waiting: 2, invalidRows: null, unfedSlots: 2, unfedLanes: ['codex-cmp'],
      resources: expect.arrayContaining([
        expect.objectContaining({ lane: 'codex-cmp', readyHinted: null, waitingElsewhere: 2, unfed: true }),
      ]),
    });
  });

  it('reports utilization, unfed lanes and windowed history from the runs directory', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({
      schema: 'dispatchd.status.v1', last_tick: new Date().toISOString(), lanes: LANES,
    }));
    writeFileSync(join(dir, 'queue', 'ready.tsv'), READY);
    const t = Date.now() / 1000;
    writeFileSync(join(dir, 'metrics', 'work-market.jsonl'), [
      unfedRow(t - 600, { 'codex-cmp': { unfed: true, headroom: 2, waiting_elsewhere: 4, blocked: { missing_capability: 4 } } }),
      unfedRow(t - 3 * 3600, { 'codex-cmp': { unfed: true, headroom: 1, waiting_elsewhere: 1, blocked: {} } }),
      decisionRow('RQ-M1', t - 500),
      decisionRow('RQ-M2', t - 400),
      // RQ-M1's latest decision also records the lanes it rejected and why.
      JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job: 'RQ-M1', ts: t - 100, chosen_lane: 'claude', preferred_lane: 'codex-personal', override: null,
        rejected_lanes: [{ lane: 'codex-cmp', reason_codes: ['saturated'] }, { lane: 'devin', reason_codes: ['quota_exhausted'] }] }),
    ].join('\n') + '\n');
    const claimTs = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), [
      JSON.stringify({ event: 'claim', job: 'RQ-J1', repo: 'phantom', lane: 'claude', tier: 'work', ts: claimTs(50_000) }),
      JSON.stringify({ event: 'batch_claim', job: 'RQ-J2', batch: 'B-1', repo: 'phantom', lane: 'claude', tier: 'work', ts: claimTs(40_000), lane_hint: 'devin', lane_override: 'batch_session' }),
      JSON.stringify({ event: 'claim', job: 'RQ-J3', repo: 'phantom', lane: 'codex-cmp', tier: 'work', ts: claimTs(30_000), lane_hint: 'codex-personal', lane_override: 'preferred_lane_fallback' }),
      JSON.stringify({ event: 'claim', job: 'RQ-J4', repo: 'phantom', lane: 'devin', tier: 'work', ts: claimTs(3_700_000) }),
      // Recorded outcomes for the two decided jobs: RQ-M1 merged, RQ-M2 closed unmerged.
      JSON.stringify({ event: 'finish', job: 'RQ-M1', phase: 'MERGED', ts: claimTs(20_000) }),
      JSON.stringify({ event: 'finish', job: 'RQ-M2', phase: 'CLOSED', ts: claimTs(10_000) }),
    ].join('\n') + '\n');
    const json = await run(['--json', '--window', '1']);
    expect(json.code).toBe(1);
    const report = JSON.parse(json.lines[0]!);
    expect(report).toMatchObject({
      schema: 'fleet.unfed.v1', readOnly: true, source: 'derived',
      unfedLanes: ['codex-cmp'], unfedSlots: 3,
      statusAsOf: expect.any(String), statusFresh: true,
    });
    expect(report.marketTruncated).toBe(false);
    expect(report.history).toMatchObject({ windowHours: 1, available: true, ticks: 1 });
    expect(report.history.lanes[0]).toMatchObject({ lane: 'codex-cmp', unfedTicks: 1, slotTicks: 2 });
    // RQ-M1's latest in-window decision ran on-hint; only RQ-M2 counts as overridden.
    expect(report.overrides).toEqual({
      available: true, decided: 2, overridden: 1,
      byReason: { preferred_lane_fallback: 1 },
      lanes: [{ from: 'codex-personal', to: 'claude', reason: 'preferred_lane_fallback', jobs: 1 }],
    });
    // Claims count launch events in the window: RQ-J4 is outside it, RQ-J1 ran on-hint.
    expect(report.claims).toEqual({
      available: true, truncated: false, claimed: 3, overridden: 2,
      byReason: { batch_session: 1, preferred_lane_fallback: 1 },
      lanes: [
        { from: 'codex-personal', to: 'codex-cmp', reason: 'preferred_lane_fallback', claims: 1 },
        { from: 'devin', to: 'claude', reason: 'batch_session', claims: 1 },
      ],
    });
    // Decision outcomes join the same two decided jobs to their finish rows:
    // RQ-M1's latest decision left its preference with no override record
    // (unexplained) and merged; RQ-M2 recorded an override and closed unmerged.
    expect(report.decisionOutcomes).toEqual({
      available: true, jobsAvailable: true, jobsTruncated: false, decided: 2,
      hinted: { decided: 0, known: 0, merged: 0, unmerged: 0, reverted: 0, unresolved: 0 },
      overridden: { decided: 1, known: 1, merged: 0, unmerged: 1, reverted: 0, unresolved: 0 },
      open: { decided: 0, known: 0, merged: 0, unmerged: 0, reverted: 0, unresolved: 0 },
      unrouted: { decided: 0, known: 0, merged: 0, unmerged: 0, reverted: 0, unresolved: 0 },
      unexplained: { decided: 1, known: 1, merged: 1, unmerged: 0, reverted: 0, unresolved: 0 },
      byReason: { preferred_lane_fallback: 1 },
      byClass: { unclassified: { decided: 2, known: 2, merged: 1, unmerged: 1, reverted: 0, unresolved: 0 } },
    });
    // Only RQ-M1's latest decision recorded rejected_lanes; RQ-M2's did not.
    expect(report.rejections).toEqual({
      available: true, decided: 2, unrouted: 0,
      lanes: [
        { lane: 'codex-cmp', jobs: 1, reasons: { saturated: 1 } },
        { lane: 'devin', jobs: 1, reasons: { quota_exhausted: 1 } },
      ],
      byReason: { saturated: 1, quota_exhausted: 1 },
    });
    vi.restoreAllMocks();
    const text = await run([]);
    expect(text.code).toBe(1);
    const body = text.lines.join('\n');
    expect(body).toContain('codex-cmp  1/4 running (25%), 1 hinted here  UNFED: 3 free, 3 rows waiting elsewhere');
    expect(body).toContain('devin  0/3 running (0%), 0 hinted here  HELD');
    expect(body).toContain('Up to 3 unfed slot(s) across codex-cmp; 4 rows waiting.');
    expect(body).toContain('Last 24h: 2 tick(s) left capacity unfed.');
    expect(body).toContain('codex-cmp: 2 tick(s), 3 slot-tick(s) lost (missing_capability 4)');
    expect(body).toContain('Last 24h: 2 job(s) decided, 1 left their hinted lane.');
    expect(body).toContain('override reasons: preferred_lane_fallback 1');
    expect(body).toContain('codex-personal -> claude (preferred_lane_fallback): 1 job(s)');
    // The text run uses the default 24h window, so RQ-J4 (62 min old) counts as a claim too.
    expect(body).toContain('Last 24h: 4 claim(s) launched, 2 left their hinted lane.');
    expect(body).toContain('claim override reasons: batch_session 1, preferred_lane_fallback 1');
    expect(body).toContain('codex-personal -> codex-cmp (preferred_lane_fallback): 1 claim(s)');
    expect(body).toContain('devin -> claude (batch_session): 1 claim(s)');
    expect(body).toContain('Last 24h: outcomes for 2 decided job(s): 1 merged, 1 unmerged, 0 unresolved.');
    expect(body).toContain('overridden: 1 decided, 0 merged, 1 unmerged, 0 unresolved');
    expect(body).toContain('unexplained: 1 decided, 1 merged, 0 unmerged, 0 unresolved');
    expect(body).toContain('Last 24h: lane rejections across 2 decided job(s): quota_exhausted 1, saturated 1');
    expect(body).toContain('codex-cmp: 1 job(s) rejected (saturated 1)');
    expect(body).toContain('devin: 1 job(s) rejected (quota_exhausted 1)');
  });

  it('labels window folds built from a truncated work-market journal', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), '{"lanes":{}}');
    const market = join(dir, 'metrics', 'work-market.jsonl');
    writeFileSync(market, decisionRow('RQ-OLDER', Date.now() / 1000 - 60) + '\n');
    truncateSync(market, 32 * 1024 * 1024);
    appendFileSync(market, '\n' + decisionRow('RQ-RETAINED', Date.now() / 1000 - 30) + '\n');

    const json = await run();
    expect(JSON.parse(json.lines[0]!)).toMatchObject({
      marketTruncated: true,
      history: { available: true, ticks: 0 },
      overrides: { available: true, decided: 1 },
    });
    vi.restoreAllMocks();
    const text = await run([]);
    expect(text.lines.join('\n')).toContain('Last 24h: work-market journal tail only.');
  });

  it('exits 0 with no unfed capacity and no history file', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({
      schema: 'dispatchd.status.v1', last_tick: new Date().toISOString(),
      lanes: { a: { running: 2, target: 2 } },
    }));
    writeFileSync(join(dir, 'queue', 'ready.tsv'), '');
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([
      'a  2/2 running (100%), 0 hinted here',
      'No unfed capacity: 0 rows waiting.',
      'Derived from lane counts and ready.tsv hints: this dispatcher does not publish reasons.',
      'Last 24h: no metrics/work-market.jsonl history.',
    ]);
  });

  it('returns an unknown live verdict for stale status and preserves counts in both formats', async () => {
    const staleTick = new Date(Date.now() - 10 * 60_000).toISOString();
    writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({
      schema: 'dispatchd.status.v1', last_tick: staleTick, lanes: LANES,
    }));
    writeFileSync(join(dir, 'queue', 'ready.tsv'), READY);
    const json = await run(['--json']);
    expect(json.code).toBe(2);
    const report = JSON.parse(json.lines[0]!);
    expect(report).toMatchObject({ statusAsOf: staleTick, statusFresh: false, unfedLanes: ['codex-cmp'] });
    vi.restoreAllMocks();
    const text = await run([]);
    expect(text.code).toBe(2);
    expect(text.lines.join('\n')).toContain(`Status snapshot is stale: last dispatcher tick ${staleTick}`);
    expect(text.lines.join('\n')).toContain('Up to 3 unfed slot(s) across codex-cmp');
  });

  it.each([
    ['missing', undefined],
    ['future', new Date(Date.now() + 60_000).toISOString()],
  ])('returns an unknown live verdict for a %s tick even with no waiting work', async (_kind, lastTick) => {
    writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({
      schema: 'dispatchd.status.v1', last_tick: lastTick, lanes: LANES,
    }));
    writeFileSync(join(dir, 'queue', 'ready.tsv'), '');
    const result = await run();
    expect(result.code).toBe(2);
    expect(JSON.parse(result.lines[0]!)).toMatchObject({ statusFresh: false, unfedSlots: 0 });
  });

  it('signals a confirmed unfed lane even when the fleet-wide bound is unknown', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({
      schema: 'dispatchd.status.v1', last_tick: new Date().toISOString(),
      lanes: { a: { running: 0, target: 2 }, b: { running: 0, target: 2 } },
      unfed_capacity: { waiting: 2, lanes: { a: { waiting_elsewhere: 1 } } },
    }));
    const result = await run();
    expect(result.code).toBe(1);
    expect(JSON.parse(result.lines[0]!)).toMatchObject({ statusFresh: true, unfedSlots: null, unfedLanes: ['a'] });
  });
});

describe('status freshness', () => {
  const NOW = 1_800_000_000_000;
  const status = (lastTick?: unknown) => JSON.stringify({
    schema: 'dispatchd.status.v1',
    lanes: { a: { running: 0, target: 2 } },
    ...(lastTick === undefined ? {} : { last_tick: lastTick }),
  });
  const render = (report: ReturnType<typeof currentUnfed>) =>
    renderUnfed({ ...report, marketTruncated: false, history: foldUnfedHistory('', 0, 24), overrides: foldMarketOverrides('', 0, 24), claims: foldClaimOverrides('', 0, 24), decisionOutcomes: foldDecisionOutcomes('', '', 0, 24), rejections: foldRouteRejections('', 0, 24) });

  it('marks a fresh dispatcher tick fresh and reports its timestamp', () => {
    const tick = new Date(NOW - 30_000).toISOString();
    const report = currentUnfed(status(tick), '', { nowMs: NOW });
    expect(report.statusAsOf).toBe(tick);
    expect(report.statusFresh).toBe(true);
    expect(render(report).join('\n')).not.toContain('Status snapshot');
  });

  it('flags stale, future, missing and unverifiable ticks without hiding the counts', () => {
    const stale = new Date(NOW - 121_000).toISOString();
    const old = currentUnfed(status(stale), '', { nowMs: NOW });
    expect(old.statusFresh).toBe(false);
    expect(old.statusAsOf).toBe(stale);
    expect(render(old).join('\n')).toContain(`Status snapshot is stale: last dispatcher tick ${stale}`);
    // Exactly at the two-minute boundary is still fresh.
    expect(currentUnfed(status(new Date(NOW - 120_000).toISOString()), '', { nowMs: NOW }).statusFresh).toBe(true);
    // A future-dated tick proves nothing about freshness.
    expect(currentUnfed(status(new Date(NOW + 60_000).toISOString()), '', { nowMs: NOW }).statusFresh).toBe(false);
    // No readable tick: age unknown, never assumed fresh.
    for (const bad of [status(undefined), status('not a date'), status(1_800_000_000)]) {
      const report = currentUnfed(bad, '', { nowMs: NOW });
      expect(report.statusFresh).toBe(false);
      expect(report.statusAsOf).toBeNull();
    }
    expect(render(currentUnfed(status(undefined), '', { nowMs: NOW })).join('\n'))
      .toContain('Status snapshot age unknown: status.json has no readable last_tick');
    // A file without the dispatcher schema is not a live tick at all.
    const foreign = JSON.stringify({ lanes: { a: { running: 0, target: 2 } }, last_tick: new Date(NOW).toISOString() });
    expect(currentUnfed(foreign, '', { nowMs: NOW }).statusFresh).toBe(false);
  });

  it('leaves freshness unknown when no evaluation clock is supplied', () => {
    const report = currentUnfed(JSON.stringify({ lanes: { a: { running: 0, target: 2 } } }), '');
    expect(report.statusFresh).toBeNull();
    expect(report.statusAsOf).toBeNull();
    expect(render(report).join('\n')).not.toContain('Status snapshot');
  });
});

describe('renderUnfed', () => {
  it('says so when there are no lanes', () => {
    const report = { ...currentUnfed('{"lanes":{}}', ''), marketTruncated: false, history: foldUnfedHistory('', 0, 24), overrides: foldMarketOverrides('', 0, 24), claims: foldClaimOverrides('', 0, 24), decisionOutcomes: foldDecisionOutcomes('', '', 0, 24), rejections: foldRouteRejections('', 0, 24) };
    expect(renderUnfed(report)).toEqual(['No lanes in queue/status.json.', 'No unfed capacity: 0 rows waiting.',
      'Derived from lane counts and ready.tsv hints: this dispatcher does not publish reasons.', 'Last 24h: no unfed ticks recorded.',
      'Last 24h: no route decisions recorded.', 'Last 24h: no claims recorded.']);
  });
});

describe('derived market reasons', () => {
  const MLANES = {
    'codex-personal': { running: 0, target: 2, held: false },
    cursor: { running: 0, target: 2, held: false },
    'codex-local': { running: 0, target: 1, held: false },
  };
  const mrow = (job: string, lane: string, tier: string, req?: string) =>
    [job, 'phantom', lane, tier, `/q/prompts/${job}.md`, ...(req === undefined ? [] : [req])].join('\t');
  const SLOTS = JSON.stringify({ 'codex-personal': {}, cursor: { tiers: ['fast', 'work'] }, 'codex-local': {} });
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
    // codex-personal is a builtin with all tiers: only the pinned and secrets rows are truly blocked.
    expect(byLane['codex-personal']!.blocked).toEqual({
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

  it('uses the first valid row per job for derived waiting and blocker counts', () => {
    const ready = [
      mrow('RQ-DUP', 'codex-personal', 'work', '{broken'),
      mrow('RQ-DUP', 'claude', 'work', '{"needs":["browser"]}'),
      mrow('RQ-DUP', 'claude', 'work'),
      mrow('RQ-DUP', 'codex-personal', 'work'),
    ].join('\n');
    const report = currentUnfed(JSON.stringify({ lanes: MLANES }), ready, { slots: SLOTS });
    expect(report).toMatchObject({ waiting: 1, invalidRows: 1, unfedSlots: 1 });
    const lane = report.resources.find(r => r.lane === 'codex-personal');
    expect(lane).toMatchObject({ readyHinted: 0, waitingElsewhere: 1 });
    expect(lane?.blocked).toEqual({ missing_capability: 1 });
  });

  it('requires explicit metered opt-in for API lanes with a known metered cost class', () => {
    const ready = [
      mrow('RQ-DEFAULT', 'claude', 'work'),
      mrow('RQ-INCLUDED', 'claude', 'work', '{"max_cost_class":"included"}'),
      mrow('RQ-METERED', 'claude', 'work', '{"max_cost_class":"metered"}'),
    ].join('\n');
    const lanes = {
      'claude-api': { running: 0, target: 2, held: false },
      'openai-api': { running: 0, target: 2, held: false },
    };
    const report = currentUnfed(JSON.stringify({ lanes }), ready, {
      slots: JSON.stringify({
        'claude-api': {},
        'openai-api': { cost_class: 'metered', tiers: ['work'] },
      }),
    });
    expect(report.resources.map(({ lane, blocked }) => [lane, blocked])).toEqual([
      ['claude-api', { metered_api_opt_in_required: 2, cost_class_exceeded: 1, deferred_after_selection: 1 }],
      ['openai-api', { metered_api_opt_in_required: 2, cost_class_exceeded: 1, deferred_after_selection: 1 }],
    ]);
  });

  it('does not recompute reasons when the dispatcher published its verdict', () => {
    const status = JSON.stringify({
      lanes: MLANES,
      unfed_capacity: { waiting: 1, lanes: { 'codex-personal': { waiting_elsewhere: 1, blocked: { saturated: 1 } } } },
    });
    const hinted = mrow('RQ-HINTED', 'codex-personal', 'work');
    const report = currentUnfed(status, [READY2, hinted, hinted].join('\n'), { slots: SLOTS, hold: 'codex-personal' });
    expect(report.source).toBe('dispatcher');
    expect(report.derivedReasons).toBe(false);
    expect(report.resources.find(r => r.lane === 'codex-personal')).toMatchObject({
      held: false, unfed: true, readyHinted: 1, waitingElsewhere: 1, blocked: { saturated: 1 },
    });
  });
});

describe('ready row validation', () => {
  const VLANES = {
    a: { running: 0, target: 2, held: false },
    b: { running: 0, target: 2, held: false },
  };
  const vrow = (job: string, lane: string, tier = 'work', req?: string, repo = 'phantom') =>
    [job, repo, lane, tier, `/q/prompts/${job}.md`, ...(req === undefined ? [] : [req])].join('\t');

  it('rejects rows the dispatcher drops before the market sees them', () => {
    const ready = [
      vrow('RQ-OK', 'a'),
      vrow('RQ-BADKEY', 'a', 'work', '{"preferred_lane":"a","bogus":1}'),
      vrow('RQ-BADPREF', 'a', 'work', '{"preferred_lane":"NOT_A_LANE"}'),
      vrow('RQ-BADNEEDS', 'a', 'work', '{"needs":"git"}'),
      vrow('RQ-BADNEEDSCAP', 'a', 'work', '{"needs":["git","Bad_Cap"]}'),
      vrow('RQ-BADTIERORD', 'a', 'work', '{"min_tier":"work","max_tier":"fast"}'),
      vrow('RQ-BADREPO', 'other', 'a', 'work', '{"repo":"phantom"}'),
      vrow('RQ-NULLSPEC', 'a', 'work', 'null'),
      vrow('RQ-ARRSPEC', 'a', 'work', '[1,2]'),
      vrow('RQ BAD JOB', 'a'),
      vrow('RQ-BADTIER', 'a', 'bogus-tier'),
      vrow('RQ-BADREPOP', 'a', 'work', undefined, 'a/b'),
      vrow('RQ-BADLANECOL', 'NOT_A_LANE'),
      'RQ-SHORT\ta\tb',
    ].join('\n');
    const hints = readyHints(ready);
    expect(hints.waiting).toBe(1);
    expect(hints.invalid).toBe(12);
    expect(Object.fromEntries(hints.byLane)).toEqual({ a: 1 });
    const report = currentUnfed(JSON.stringify({ lanes: VLANES }), ready);
    expect(report.waiting).toBe(1);
    expect(report.invalidRows).toBe(12);
    // Only the valid row waits, hinted at a: b still sees one row elsewhere.
    expect(report.resources.find(r => r.lane === 'b')).toMatchObject({ waitingElsewhere: 1, unfed: true });
    expect(report.resources.find(r => r.lane === 'a')).toMatchObject({ readyHinted: 1, waitingElsewhere: 0, unfed: false });
  });

  it('rejects inherited names in closed tier, cost and data-class fields', () => {
    const ready = [
      vrow('RQ-TIER', 'a', 'constructor'),
      vrow('RQ-MIN', 'a', 'work', '{"min_tier":"toString"}'),
      vrow('RQ-MAX', 'a', 'work', '{"max_tier":"valueOf"}'),
      vrow('RQ-COST', 'a', 'work', '{"max_cost_class":"__proto__"}'),
      vrow('RQ-DATA', 'a', 'work', '{"data_class":"hasOwnProperty"}'),
    ].join('\n');
    const report = currentUnfed(JSON.stringify({ lanes: VLANES }), ready);
    expect(report).toMatchObject({ waiting: 0, invalidRows: 5, unfedLanes: [] });
  });

  it('resolves spec-less rows from the router-queue.md envelope like the dispatcher', () => {
    const routerQueue = [
      '- READY RQ-ENV (P1, pool=codex-personal, needs=git|secrets:DEPLOY_KEY, tier=mid): do the thing',
      '- CLAIMED 03:17 dispatchd worker RQ-ENV2 (lane=claude, exclusive=true, impact=2): other',
      '- READY RQ-SPEC (P1, pool=claude): conflicting envelope the spec column overrides',
    ].join('\n');
    const ready = [
      vrow('RQ-ENV', 'codex-cmp'),
      vrow('RQ-ENV2', 'codex-cmp'),
      vrow('RQ-PLAIN', 'codex-cmp'),
      vrow('RQ-SPEC', 'codex-cmp', 'work', '{"preferred_lane":"devin"}'),
    ].join('\n');
    const hints = readyHints(ready, routerQueue);
    expect(hints.waiting).toBe(4);
    expect(hints.invalid).toBe(0);
    // pool=/lane= attrs beat the lane column; an embedded spec column beats the envelope.
    expect(hints.rows[0]).toMatchObject({ hint: 'codex-personal', needs: ['git', 'secrets:DEPLOY_KEY'] });
    expect(hints.rows[1]).toMatchObject({ hint: 'claude' });
    expect(hints.rows[2]).toMatchObject({ hint: 'codex-cmp', needs: [] });
    expect(hints.rows[3]).toMatchObject({ hint: 'devin' });
  });

  it('rejects a row whose envelope fails validation', () => {
    const routerQueue = '- READY RQ-BADENV (P1, pool=codex-cmp, exclusive=maybe): x';
    const hints = readyHints(vrow('RQ-BADENV', 'codex-cmp'), routerQueue);
    expect(hints.waiting).toBe(0);
    expect(hints.invalid).toBe(1);
  });

  it('lets the envelope replace a bad lane cell, while a bare bad lane cell still rejects', () => {
    // dispatchd's routed pass resolves the `(attrs)` envelope before launch
    // and writes the spec into the requirements cell, so the lane column is
    // never consulted for an enveloped row — a bad lane cell cannot reject
    // it. With no envelope the requirements fallback still applies: the lane
    // column defaults to preferred_lane and must be a lane id or empty.
    const routerQueue = [
      '- READY RQ-BADLANE (P1, pool=codex-cmp): valid envelope',
      '- READY RQ-OPENLANE (P1, pool=claude): envelope supplies the hint',
    ].join('\n');
    const ready = [
      vrow('RQ-BADLANE', 'NOT_A_LANE'),
      vrow('RQ-OPENLANE', ''),
      vrow('RQ-NOENV', 'NOT_A_LANE'),
      'RQ-RAWOPEN\tphantom\t\twork\t/q/prompts/RQ-RAWOPEN.md',
    ].join('\n');
    const hints = readyHints(ready, routerQueue);
    expect(hints.waiting).toBe(3);
    expect(hints.invalid).toBe(1);
    // The envelope's pool= hint applies past the bad lane cell; an empty lane
    // cell with no envelope stays open.
    expect(hints.rows[0]).toMatchObject({ hint: 'codex-cmp' });
    expect(hints.rows[1]).toMatchObject({ hint: 'claude' });
    expect(hints.rows[2]).toMatchObject({ hint: null });
  });

  it('keeps the row repo through the envelope like the dispatcher re-parse', () => {
    const routerQueue = '- READY RQ-ENV (P1): open envelope row';
    const ready = vrow('RQ-ENV', 'codex-personal');
    const hints = readyHints(ready, routerQueue);
    expect(hints.rows[0]).toMatchObject({ hint: null, repo: 'phantom' });
    // repo_unserved is scored by the real repo: served on codex-personal's allowlist,
    // blocked on claude's — never reported for every envelope row at once.
    const lanes = {
      'codex-personal': { running: 0, target: 1, held: false },
      claude: { running: 0, target: 1, held: false },
    };
    const slots = JSON.stringify({ 'codex-personal': { repos: ['phantom'] }, claude: { repos: ['other-repo'] } });
    const report = currentUnfed(JSON.stringify({ lanes }), ready, { slots, routerQueue });
    const byLane = Object.fromEntries(report.resources.map(r => [r.lane, r]));
    expect(byLane['codex-personal']!.blocked).toEqual({ deferred_after_selection: 1 });
    expect(byLane.claude!.blocked).toEqual({ repo_unserved: 1 });
  });

  it('counts the first JID+tier-valid row per job by raw lane when admission stopped', () => {
    const status = JSON.stringify({ lanes: VLANES, paused: 'hold' });
    const ready = [
      vrow('RQ-OK', 'a'),
      vrow('RQ-BADSPEC', 'a', 'work', '{"bogus":1}'),
      vrow('RQ-BADSPEC', 'b'),
      vrow('RQ-BADTIER', 'a', 'bogus-tier'),
    ].join('\n');
    const report = currentUnfed(status, ready);
    expect(report.fleetStop).toBe('admission_stopped');
    // The stopped _waiting never parses requirements: the bad spec still waits,
    // hinted by its raw lane column; the bad tier row does not.
    expect(report.waiting).toBe(2);
    expect(report.invalidRows).toBe(2);
    expect(report.resources.find(r => r.lane === 'a')).toMatchObject({ readyHinted: 2, waitingElsewhere: 0, unfed: false });
    expect(report.resources.find(r => r.lane === 'b')).toMatchObject({ waitingElsewhere: 2, unfed: true, blocked: { admission_stopped: 2 } });
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

  it('uses timestamped admission evidence only from the status tick', () => {
    const tick = '2026-11-26T10:00:00-0500';
    const ready = [TWO_WAITING, `${row('RQ-INVALID', 'b')}\t{broken`].join('\n');
    const reportAt = (ts: string) => currentUnfed(JSON.stringify({
      last_tick: tick,
      lanes: STOP_LANES,
      admission: { ts, gate_reason: 'load guard', admit: false },
    }), ready);

    expect(reportAt(tick)).toMatchObject({ fleetStop: 'admission_stopped', waiting: 3 });
    for (const ts of ['2026-11-26T09:59:59-0500', '2026-11-26T10:00:01-0500']) {
      const report = reportAt(ts);
      expect(report).toMatchObject({ fleetStop: null, waiting: 2, invalidRows: 1 });
      expect(report.resources.find(r => r.lane === 'a')?.blocked).toEqual({});
    }
  });

  it('reads the stop code back from dispatcher-published blocked reasons', () => {
    const status = JSON.stringify({
      lanes: STOP_LANES,
      last_tick: '2026-11-26T10:00:00-0500',
      admission: { ts: '2026-11-26T09:59:59-0500', running: 4, cap: 4 },
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

  it.each([
    [{ paused: 'maintenance' }, 'admission_stopped'],
    [{ admission: { gate_reason: 'load guard' } }, 'admission_stopped'],
    [{ admission: { running: 1, cap: 1 } }, 'global_admission'],
    [{ admission: { claim_limit: 1 }, launched_this_tick: ['RQ-1'] }, 'global_admission'],
  ])('honors the fleet stop with published lane data and no blocked rows (%j)', (extra, stop) => {
    const report = currentUnfed(JSON.stringify({
      lanes: STOP_LANES,
      ...extra,
      unfed_capacity: {
        waiting: 0,
        lanes: { a: { waiting_elsewhere: 0, blocked: {} } },
      },
    }), '');
    expect(report).toMatchObject({ source: 'dispatcher', fleetStop: stop, unfedLanes: [] });
  });

  it('prints the fleet stop line in text output', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({
      schema: 'dispatchd.status.v1', last_tick: new Date().toISOString(), lanes: STOP_LANES, paused: 'hold',
    }));
    writeFileSync(join(dir, 'queue', 'ready.tsv'), TWO_WAITING);
    const result = await run([]);
    expect(result.code).toBe(1);
    expect(result.lines).toContain('a  0/2 running (0%), 0 hinted here  UNFED: 2 free, 2 rows waiting elsewhere (admission_stopped 2)');
    expect(result.lines.join('\n')).toContain('Fleet admission stopped (pause, disk guard or load gate)');
    expect(result.lines.join('\n')).toContain('status.json admission verdict');
  });
});
