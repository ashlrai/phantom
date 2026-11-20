/** Fixture tests for per-model caps: Fable limit -> Opus, clears at reset, unknown never moves work, pools JSON. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './helpers/local-memory.js';
import { cmdPools } from '../src/cli/pools.js';
import { buildPoolsView, formatPoolsText } from '../src/core/fleet/pools-view.js';
import type { ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';
import { decideRoute } from '../src/core/routing/decision.js';
import { loadRouteSources } from '../src/core/routing/decision-candidates.js';
import { applyModelCap, parseLimitMessage, readModelCaps, recordModelCap, resolveModelCaps } from '../src/core/routing/model-caps.js';

const NOW = Date.parse('2026-11-19T21:45:00.000Z');
const RESET = '2026-11-20T18:00:00.000Z';
const dirs: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'model-caps-')); dirs.push(dir); return dir; };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const request = { job: 'job', repo: 'phantom', task_class: 'bug-fix', tier_hint: 'work', lane_candidates: ['claude'],
  quota_state: { claude: 'available' }, machine_state: { admit: true, running_by_lane: { claude: 0 } } };
const routeSources = (modelCaps: ReturnType<typeof resolveModelCaps>) => ({
  models: { claude: 'claude-fable-5-2' }, admission: { admit: true }, modelCaps,
  slots: { claude: { target: 2, hard_cap: 2, capabilities: ['git'], tiers: ['work'], cost_class: 'included', data_class: 'internal' } },
});
const stored = (fable: Record<string, unknown>, opus: Record<string, unknown> = {}) => ({ caps: [{ model: 'fable', ...fable }, { model: 'opus', ...opus }] });
const fableCapped = { capped: true, since: '2026-11-19T21:45:00.000Z', resetAt: RESET, source: "You've reached your Fable limit" };

describe('router rule', () => {
  it('moves a capped Fable job to Opus and says where it came from', async () => {
    const report = await decideRoute(request, routeSources(resolveModelCaps(stored(fableCapped), NOW)), { nowMs: NOW });
    expect(report).toMatchObject({ lane: 'claude', model: 'claude-opus-5-5', fallback_from: 'claude-fable-5-2' });
  });

  it('goes on to Sonnet when Opus is capped too, and stays put when every later model is capped', () => {
    const caps = resolveModelCaps(stored(fableCapped, { capped: true, resetAt: RESET, since: fableCapped.since }), NOW);
    expect(applyModelCap('claude-fable-5-2', caps)).toEqual({ model: 'claude-sonnet-5-5', fallback_from: 'claude-fable-5-2' });
    const all = caps.map(row => ({ ...row, capped: true }));
    expect(applyModelCap('claude-fable-5-2', all)).toEqual({ model: 'claude-fable-5-2', fallback_from: null });
  });

  it('clears the cap at the plan reset time', async () => {
    const before = resolveModelCaps(stored(fableCapped), NOW);
    const after = resolveModelCaps(stored(fableCapped), Date.parse(RESET) + 1);
    expect(before[0]).toMatchObject({ model: 'fable', capped: true });
    expect(after[0]).toMatchObject({ model: 'fable', capped: false, since: fableCapped.since });
    const report = await decideRoute(request, routeSources(after), { nowMs: Date.parse(RESET) + 1 });
    expect(report).toMatchObject({ model: 'claude-fable-5-2' });
    expect(report).not.toHaveProperty('fallback_from');
  });

  it('never moves work on an unknown cap', async () => {
    const unknown = resolveModelCaps(null, NOW);
    expect(unknown.map(row => row.capped)).toEqual([null, null, null]);
    expect(applyModelCap('claude-fable-5-2', unknown)).toEqual({ model: 'claude-fable-5-2', fallback_from: null });
    const report = await decideRoute(request, routeSources(unknown), { nowMs: NOW });
    expect(report).toMatchObject({ model: 'claude-fable-5-2' });
    expect(report).not.toHaveProperty('fallback_from');
  });
});

describe('recording a limit', () => {
  it('reads the model from the message and clears at the plan reset', async () => {
    const root = await temp();
    expect(parseLimitMessage("You've reached your Fable limit")).toBe('fable');
    expect(parseLimitMessage('You have reached your weekly limit')).toBeNull();
    await recordModelCap(root, { model: 'fable', message: "You've reached your Fable limit", planResetAt: RESET }, NOW);
    expect((await readModelCaps(root, NOW))[0]).toMatchObject({ model: 'fable', capped: true, resetAt: RESET, source: "You've reached your Fable limit" });
    expect((await loadRouteSources(root)).modelCaps?.[0]?.capped).toBe(true);
    expect((await readModelCaps(root, Date.parse(RESET) + 1))[0]?.capped).toBe(false);
    await recordModelCap(root, { model: 'fable', clear: true }, NOW);
    expect((await readModelCaps(root, NOW))[0]?.capped).toBe(false);
  });

  it('re-checks after six hours when no reset is known', async () => {
    const root = await temp();
    await recordModelCap(root, { model: 'fable' }, NOW);
    expect((await readModelCaps(root, NOW + 5 * 3_600_000))[0]?.capped).toBe(true);
    expect((await readModelCaps(root, NOW + 7 * 3_600_000))[0]?.capped).toBe(false);
  });
});

describe('phm pools', () => {
  const ledger = (modelCaps: ReturnType<typeof resolveModelCaps>): ResourceLedgerV1 => ({
    v: 1, generatedAt: new Date(NOW).toISOString(), sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' }, asOf: new Date(NOW).toISOString(),
    lanes: [{ lane: 'claude', running: 1, target: 2, held: false, window: 'weekly', usedPct: 84, creditsRemaining: null, resetAt: RESET,
      burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null, modelCaps }],
    apiSpend: null, jobsMalformedRows: null,
  });

  it('shows each model cap in the pools JSON and text', () => {
    const view = buildPoolsView(ledger(resolveModelCaps(stored(fableCapped), NOW)), NOW);
    expect(view.pools[0]!.modelCaps).toEqual([
      { model: 'fable', capped: true, since: fableCapped.since, resetAt: RESET, source: fableCapped.source },
      { model: 'opus', capped: null, since: null, resetAt: null, source: null },
      { model: 'sonnet', capped: null, since: null, resetAt: null, source: null },
    ]);
    expect(formatPoolsText(view)).toContain(`fable: at its own limit since ${fableCapped.since}, clears ${RESET}; work moves to the next model`);
  });

  it('records a cap from the command line and prints the three rows', async () => {
    const root = await temp();
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdPools(['cap', '--message', "You've reached your Fable limit", '--reset-at', RESET])).toBe(0);
    const rows = JSON.parse(out.mock.calls[0]![0] as string) as { model: string; capped: boolean | null }[];
    expect(rows.map(row => [row.model, row.capped])).toEqual([['fable', true], ['opus', null], ['sonnet', null]]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdPools(['cap', '--message', 'no model named here'])).toBe(2);
    vi.unstubAllEnvs();
  });
});
