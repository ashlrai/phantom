import { describe, expect, it } from 'vitest';
import type { ModelCheckReport, ModelCheckRow } from '../../../../core/fleet/model-check.js';
import type { ModelRegistryRow } from '../../../../core/fleet/model-verify.js';
import type { FleetLaneModelsV1 } from '../../../../core/verse/fleet-lane-models-contract.js';
import { boardGroups, boardModels, filterCounts, groupLine, lanesText, matchesFilter } from './models-board-model.js';

const entry = (id: string, extra: Partial<ModelRegistryRow> = {}): ModelRegistryRow => ({
  id, provider: 'openai', lanes: [], verified: true, status: 'verified', source_url: 'https://docs.example.test/m', verified_on: '2026-11-05', unverified: false, stale: false, reason: null, ...extra,
});
const checked = (id: string, extra: Partial<ModelCheckRow> = {}): ModelCheckRow => ({
  id, provider: 'openai', lanes: [], source_url: 'https://docs.example.test/m', confirmed_on: '2026-11-17', state: 'confirmed', routable: true, docs: 'unknown', replacement: null, reason: null, ...extra,
});
const report = (models: ModelCheckRow[], extra: Partial<ModelCheckReport> = {}): ModelCheckReport => ({
  schema: 'models.check.v1', version: 1, summary: '', ok: false, registry: 'ok', router_choices: 'ok', docs: 'unknown', docs_as_of: null, stale_after_days: 14,
  counts: { confirmed: 0, stale: 0, unconfirmed: 0 }, models, missing: [], diff: null, error: null, ...extra,
});
const table = (lanes: FleetLaneModelsV1['lanes']): FleetLaneModelsV1 => ({ v: 1, generatedAt: '2026-11-18T12:00:00Z', source: 'ok', reason: null, lanes, launches: 3 });
const one = (id: string, models: ReturnType<typeof boardModels>) => models.find(model => model.id === id)!;

describe('boardModels', () => {
  it('takes the router\'s answer and the docs verdict from the check', () => {
    const models = boardModels({ registry: [entry('a'), entry('b'), entry('c'), entry('d')], lanes: null, check: report([
      checked('a'), checked('b', { state: 'stale' }), checked('c', { docs: 'deprecated', replacement: 'a', reason: 'Deprecated in provider docs. Move to a.' }),
      checked('d', { docs: 'retired', routable: false }),
    ]) });
    expect(models.map(m => [m.id, m.state, m.tone, m.routable, m.attention])).toEqual([
      ['a', 'Confirmed', 'ok', true, false],
      ['b', 'Stale', 'warn', true, true],
      ['c', 'Deprecated in docs', 'warn', true, true],
      ['d', 'Retired in docs · not routable', 'bad', false, true],
    ]);
    expect(one('c', models)).toMatchObject({ replacement: 'a', reason: 'Deprecated in provider docs. Move to a.', action: 'recheck' });
  });

  it('never calls a verified model routable when the check is missing: routing is unknown', () => {
    const registry = [entry('ok'), entry('old', { stale: true }), entry('new', { verified: false, unverified: true, status: 'unverified', source_url: null }), entry('gone', { verified: false, unverified: true, status: 'retired' })];
    for (const check of [null, report([], { registry: 'unknown' })]) {
      const models = boardModels({ registry, check, lanes: null });
      expect(models.map(m => [m.id, m.state, m.routable, m.attention, m.action])).toEqual([
        ['ok', 'Verified · routing unknown', null, false, 'recheck'],
        ['old', 'Stale (verified over 30 days ago) · routing unknown', null, true, 'recheck'],
        ['new', 'Unverified · not routable', false, true, 'verify'],
        ['gone', 'Retired', false, false, null],
      ]);
      expect(filterCounts(models)).toEqual({ all: 4, attention: 2, routable: 0 });
    }
  });

  it('lists a model a lane points at that the registry lacks, with no provider and nothing to verify', () => {
    const [ghost] = boardModels({ registry: [], lanes: null, check: report([checked('ghost', { provider: null, lanes: ['claude'], state: 'unconfirmed', routable: false, source_url: null, confirmed_on: null })]) });
    expect(ghost).toMatchObject({ provider: null, state: 'Unconfirmed · not routable', action: null, confirmedOn: null, sourceUrl: null });
    expect(lanesText(ghost!)).toBe('claude');
  });

  it('adds the tiers that pick each model and the newest launch that used it from the lane table', () => {
    const lanes = table([
      { lane: 'claude', family: 'claude', mismatch: false, tiers: [{ tier: 'high', model: 'm-big', via: null }, { tier: 'medium', model: 'm-big', via: null }, { tier: 'low', model: 'm-small', via: null }],
        lastLaunch: { lane: 'claude', tier: 'high', model: 'm-big', at: '2026-11-18T11:00:00Z' } },
      { lane: 'codex-cmp', family: 'codex', mismatch: false, tiers: [{ tier: 'high', model: 'm-big', via: null }],
        lastLaunch: { lane: 'codex-cmp', tier: null, model: 'm-big', at: '2026-11-18T11:30:00Z' } },
    ]);
    const models = boardModels({ registry: [entry('m-big'), entry('m-small'), entry('m-idle')], lanes, check: report([checked('m-big', { lanes: ['claude', 'spare'] }), checked('m-small'), checked('m-idle')]) });
    expect(lanesText(one('m-big', models))).toBe('claude (high, medium), codex-cmp (high), spare');
    expect(one('m-big', models).lastLaunch).toEqual({ lane: 'codex-cmp', tier: null, at: '2026-11-18T11:30:00Z' });
    expect(lanesText(one('m-small', models))).toBe('claude (low)');
    expect(one('m-small', models).lastLaunch).toBeNull();
    // No lane names it anywhere: unknown, not "none".
    expect(lanesText(one('m-idle', models))).toBeNull();
  });

  it('ignores a lane table that is unavailable', () => {
    const lanes: FleetLaneModelsV1 = { ...table([]), source: 'unavailable', reason: 'Lane model table unavailable' };
    expect(lanesText(boardModels({ registry: [entry('a', { lanes: ['codex-cmp'] })], check: null, lanes })[0]!)).toBe('codex-cmp');
  });
});

describe('boardGroups', () => {
  const models = boardModels({
    registry: [entry('z-old', { verified: false, unverified: true, status: 'retired' }), entry('o-fine'), entry('o-bad'), entry('c-fine', { provider: 'anthropic' })],
    lanes: null,
    check: report([checked('o-fine'), checked('o-bad', { routable: false, state: 'unconfirmed' }), checked('c-fine', { provider: 'anthropic' }), checked('ghost', { provider: null, routable: false, state: 'unconfirmed' })]),
  });

  it('groups by provider by name, unknown provider last, with what needs attention first and retired last', () => {
    expect(boardGroups(models).map(group => [group.provider, group.models.map(m => m.id)])).toEqual([
      ['anthropic', ['c-fine']], ['openai', ['o-bad', 'o-fine', 'z-old']], [null, ['ghost']],
    ]);
  });

  it('counts routable models per group and per filter', () => {
    expect(boardGroups(models).map(groupLine)).toEqual(['1 model, 1 routable', '3 models, 1 routable', '1 model, 0 routable']);
    expect(filterCounts(models)).toEqual({ all: 5, attention: 2, routable: 2 });
    expect(models.filter(m => matchesFilter(m, 'attention')).map(m => m.id).sort()).toEqual(['ghost', 'o-bad']);
    expect(groupLine(boardGroups(boardModels({ registry: [entry('a')], check: null, lanes: null }))[0]!)).toBe('1 model, routing unknown');
  });
});
