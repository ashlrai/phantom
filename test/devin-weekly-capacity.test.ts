import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DevinClient } from '../src/core/devin/client.js';
import type { DevinModelCatalog } from '../src/core/devin/models.js';
import {
  devinPreviewObservation, devinWeeklyLine, devinWeeklyObservation, devinWeeklyWindow, measureDevinWeekly,
  publishDevinWeeklyCapacity, readDevinWeeklyCapacity,
} from '../src/core/devin/weekly-capacity.js';
import { planBurnDown } from '../src/core/usage/resource-live/burn-down.js';
import { defaultResourceLiveSources } from '../src/core/usage/resource-live/sources.js';
import { DEVIN_FLASH_EXPIRES_AT, type ResourceLiveReading } from '../src/core/usage/resource-live/types.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ANCHOR = '2026-11-03T05:00:00.000Z'; // a Tuesday reset; window = Nov 17 05:00 → Nov 24 05:00
const sec = (iso: string): number => Date.parse(iso) / 1000;
const session = (n: number, created: number | string | undefined, acus: number | null) => ({
  session_id: `devin-${String(n).padStart(32, '0')}`, url: `https://app.devin.ai/sessions/${n}`, status: 'running', tags: [],
  ...(created === undefined ? {} : { created_at: created }), ...(acus === null ? {} : { acus_consumed: acus }),
});

/** Fake Devin API: serves the session list in pages, recording every request. */
function fakeDevin(pages: unknown[][], opts: { status?: number } = {}) {
  const calls: string[] = [];
  const fetch = async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (opts.status) return new Response('{"detail":"nope"}', { status: opts.status });
    const index = Number(url.searchParams.get('after') ?? 0);
    const more = index + 1 < pages.length;
    return Response.json({ items: pages[index], end_cursor: more ? String(index + 1) : null, has_next_page: more });
  };
  const client = new DevinClient({ apiKey: 'cog_test', baseUrl: 'https://devin.test', fetch: fetch as never, retries: 0, sleep: async () => {} });
  return { calls, listPage: (after: string | undefined) => client.listSessions('org-test', { first: 200, ...(after ? { after } : {}) }) };
}

const section = { weeklyAcuAllowance: 250, weeklyResetAt: ANCHOR };
let dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs = []; });

describe('Devin weekly capacity', () => {
  it('derives the weekly window from any reset anchor', () => {
    expect(devinWeeklyWindow(ANCHOR, NOW)).toEqual({ startMs: Date.parse('2026-11-17T05:00:00.000Z'), resetMs: Date.parse('2026-11-24T05:00:00.000Z') });
    expect(devinWeeklyWindow(undefined, NOW)).toBeNull();
  });

  it('sums acus_consumed of sessions in the current window across pages', async () => {
    const api = fakeDevin([
      [session(1, sec('2026-11-17T06:00:00.000Z'), 10), session(2, sec('2026-11-16T23:00:00.000Z'), 99)],
      [session(3, '2026-11-17T09:00:00.000Z', 4.5)],
    ]);
    const got = await readDevinWeeklyCapacity({ nowMs: NOW, section, budgetTotal: 50, listPage: api.listPage });
    expect(api.calls).toEqual(['/organizations/org-test/sessions?first=200', '/organizations/org-test/sessions?first=200&after=1']);
    expect(got).toMatchObject({
      used: 14.5, limit: 250, remaining: 235.5, limit_source: 'config', sessions: 2, state: 'live',
      window_start: '2026-11-17T05:00:00.000Z', reset_at: '2026-11-24T05:00:00.000Z', burn_rate_per_hour: 2.071,
      source: 'devin-api-v3-sessions', observed_at: new Date(NOW).toISOString(), reason: null,
    });
    expect(devinWeeklyObservation(got)).toEqual({ used: 14.5, limit: 250, unit: 'acu', reset_at: '2026-11-24T05:00:00.000Z',
      source: 'devin-api-v3-sessions', observed_at: new Date(NOW).toISOString(), window_start: '2026-11-17T05:00:00.000Z' });
  });

  it('falls back to the configured budget for the allowance', async () => {
    const api = fakeDevin([[session(1, sec('2026-11-17T06:00:00.000Z'), 20)]]);
    const got = await readDevinWeeklyCapacity({ nowMs: NOW, section: { weeklyResetAt: ANCHOR }, budgetTotal: 50, listPage: api.listPage });
    expect(got).toMatchObject({ used: 20, limit: 50, remaining: 30, limit_source: 'budget' });
  });

  it('keeps unknowns null instead of guessing', async () => {
    const noAnchor = await readDevinWeeklyCapacity({ nowMs: NOW, section: { weeklyAcuAllowance: 250 }, budgetTotal: 0, listPage: fakeDevin([[]]).listPage });
    expect(noAnchor).toMatchObject({ used: null, remaining: null, reset_at: null, burn_rate_per_hour: null, state: 'unmeasured' });
    const missingAcus = await readDevinWeeklyCapacity({ nowMs: NOW, section, listPage: fakeDevin([[session(1, sec('2026-11-17T06:00:00.000Z'), null)]]).listPage });
    expect(missingAcus).toMatchObject({ used: null, remaining: null, state: 'unmeasured' });
    const missingCreated = measureDevinWeekly({ sessions: [{ acusConsumed: 3 } as never], complete: true, allowance: { limit: 1, source: 'config' }, resetAnchor: ANCHOR, nowMs: NOW });
    expect(missingCreated.used).toBeNull();
    const failed = await readDevinWeeklyCapacity({ nowMs: NOW, section, listPage: fakeDevin([], { status: 500 }).listPage });
    expect(failed).toMatchObject({ used: null, limit: 250, reset_at: '2026-11-24T05:00:00.000Z', state: 'unmeasured' });
    expect(devinWeeklyObservation(failed)).toBeNull();
    const noLimit = await readDevinWeeklyCapacity({ nowMs: NOW, section: { weeklyResetAt: ANCHOR }, budgetTotal: 0, listPage: fakeDevin([[]]).listPage });
    expect(noLimit).toMatchObject({ used: 0, limit: null, remaining: null, state: 'live' });
    expect(devinWeeklyLine(noAnchor)).toContain('used unknown · left unknown of 250 ACU · reset unknown');
  });

  it('publishes a live reading and serves it stale after a failed read, until the reset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devin-weekly-')); dirs.push(dir);
    const file = join(dir, 'weekly-capacity.json');
    const ok = fakeDevin([[session(1, sec('2026-11-17T06:00:00.000Z'), 7)]]);
    expect(await publishDevinWeeklyCapacity({ nowMs: NOW, section, file, listPage: ok.listPage })).toMatchObject({ used: 7, state: 'live' });
    const later = NOW + 3_600_000;
    const down = fakeDevin([], { status: 503 });
    expect(await publishDevinWeeklyCapacity({ nowMs: later, section, file, listPage: down.listPage }))
      .toMatchObject({ used: 7, remaining: 243, state: 'stale', observed_at: new Date(NOW).toISOString() });
    const nextWeek = Date.parse('2026-11-24T06:00:00.000Z');
    expect(await publishDevinWeeklyCapacity({ nowMs: nextWeek, section, file, listPage: down.listPage })).toMatchObject({ used: null, state: 'unmeasured' });
  });

  it('feeds the resource-live devin allowance and its reset ordering', async () => {
    const sources = defaultResourceLiveSources({ runsDir: '/tmp/runs-none', readDevinWeekly: async (nowMs) => readDevinWeeklyCapacity({ nowMs, section, listPage: fakeDevin([[session(1, sec('2026-11-17T06:00:00.000Z'), 25)]]).listPage }),
      readDevinPublished: () => null });
    let observation = null;
    for (const source of sources.devin.slice(1)) { observation = await source.read(NOW); if (observation) break; }
    expect(observation).toMatchObject({ used: 25, limit: 250, unit: 'acu', reset_at: '2026-11-24T05:00:00.000Z', source: 'devin-api-v3-sessions' });
  });
});

describe('weekly provenance', () => {
  it('carries explicit account and configured model through measurement and observation', async () => {
    const capacity = await readDevinWeeklyCapacity({ nowMs: NOW, accountId: 'org-test',
      section: { weeklyResetAt: ANCHOR, weeklyAcuAllowance: 50, fleetModel: 'swe-2-high' }, listPage: fakeDevin([[]]).listPage });
    expect(capacity).toMatchObject({ account_id: 'org-test', model: 'swe-2-high' });
    expect(devinWeeklyObservation(capacity)).toMatchObject({ account_id: 'org-test', model: 'swe-2-high', window_start: capacity.window_start });
    const overridden = await readDevinWeeklyCapacity({ nowMs: NOW, accountId: 'org-test', model: 'swe-2-max',
      section: { weeklyResetAt: ANCHOR, fleetModel: 'swe-2-high' }, listPage: fakeDevin([[]]).listPage });
    expect(overridden.model).toBe('swe-2-max');
  });
  it('does not invent unknown scope or observations for unmeasured capacity', () => {
    const capacity = measureDevinWeekly({ sessions: null, complete: false, allowance: { limit: null, source: null }, resetAnchor: null, nowMs: NOW });
    expect(capacity).not.toHaveProperty('account_id');
    expect(capacity).not.toHaveProperty('model');
    expect(devinWeeklyObservation(capacity)).toBeNull();
  });
});

describe('Devin free-preview models', () => {
  const catalog = (ids: Array<[string, boolean]>): DevinModelCatalog => ({
    source: 'cache', fetchedAt: '2026-11-17T11:00:00.000Z', declaredFamilyCount: 1,
    families: [{ id: 'swe-2', label: 'SWE-2', aliases: [], models: ids.map(([id, free]) => ({
      family: 'swe-2', familyLabel: 'SWE-2', id, label: id, contextTokens: null, isNew: false, isBeta: false, aliases: [],
      pricing: { free, inPerM: null, outPerM: null, cachedPerM: null } })) }],
  });

  it('counts free SWE-2 Lightning/Flash models until the preview expires', () => {
    const listed = catalog([['swe-2-max-lightning', true], ['swe-2-flash', true], ['swe-2-high', true], ['swe-2-medium-flash', false]]);
    expect(devinPreviewObservation(listed, NOW)).toEqual({ used: null, limit: 2, unit: 'models', reset_at: null,
      source: 'devin-cli-models-list', observed_at: '2026-11-17T11:00:00.000Z', model: 'swe-2-max-lightning' });
    expect(devinPreviewObservation(listed, Date.parse(DEVIN_FLASH_EXPIRES_AT) + 1)).toBeNull();
    expect(devinPreviewObservation({ ...listed, fetchedAt: null }, NOW)).toBeNull();
  });

  it('ranks the zero-cost preview ahead of the included Devin allowance before expiry only', () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const row = (id: 'devin' | 'devin-flash', extra: Partial<ResourceLiveReading>): ResourceLiveReading => ({
      id, label: id, lane: id, class: id === 'devin' ? 'included' : 'expiring',
      expires_at: id === 'devin' ? null : DEVIN_FLASH_EXPIRES_AT, verified: true, used: null, limit: null, used_pct: null,
      remaining: null, unit: 'acu', reset_at: null, source: 'test', source_tier: 'official', observed_at: iso(NOW),
      stale_after: iso(NOW + 15 * 60_000), reason: null, ...extra,
    } as ResourceLiveReading);
    const readings = [
      row('devin', { used: 10, limit: 250, remaining: 240, reset_at: '2026-11-24T05:00:00.000Z' }),
      row('devin-flash', { limit: 2, unit: 'models' }),
    ];
    const plan = planBurnDown(readings, {}, NOW);
    expect(plan.lane_order.slice(0, 2)).toEqual(['devin-flash', 'devin']);
    expect(plan.allowances.find(r => r.id === 'devin-flash')).toMatchObject({ action: 'burn', deadline_at: DEVIN_FLASH_EXPIRES_AT });
    const after = Date.parse(DEVIN_FLASH_EXPIRES_AT) + 3_600_000;
    const late = planBurnDown(readings.map(r => ({ ...r, observed_at: iso(after), stale_after: iso(after + 15 * 60_000) })), {}, after);
    expect(late.allowances.find(r => r.id === 'devin-flash')?.action).not.toBe('burn');
  });
});
