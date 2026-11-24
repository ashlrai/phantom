import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectLaneAllowance, readLaneAllowance } from '../src/core/usage/lane-allowance.js';
import { DEVIN_FLASH_EXPIRES_AT, RESOURCE_LIVE_SCHEMA } from '../src/core/usage/resource-live/types.js';
import { postureEvidence } from '../src/core/queue/route-explain.js';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi } from '../src/core/web/api.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { DevinWeeklyCapacity } from '../src/core/devin/weekly-capacity.js';

const now = Date.parse('2026-12-02T00:00:00.000Z');
const iso = (offset: number) => new Date(now + offset).toISOString();
const resourceLive = (offset = 0) => ({ schema: RESOURCE_LIVE_SCHEMA, readings: [{ id: 'claude-weekly', verified: true,
  used: 62, limit: 100, unit: 'percent', reset_at: iso(3_600_000), observed_at: iso(offset), source: 'fixture', source_tier: 'official' }] });
const scopedReading = () => ({ ...resourceLive().readings[0], account_id: 'account-a', model: 'claude-opus', window_start: iso(-3_600_000) });
const scopedPosture = () => ({ posture: 'burn', postureReason: 'fixture', projectedUnusedPct: 40, hoursToReset: 1,
  observedAt: iso(0), accountId: 'account-a', model: 'claude-opus', windowStart: iso(-3_600_000), resetAt: iso(3_600_000),
  costClass: 'included', freePreview: true, allowance: { in_flight: 2 } });
describe('lane allowance', () => {
  it('passes on where the measured window began, and only for a usable reading', () => {
    const claude = (reading: Record<string, unknown>, at = now) => projectLaneAllowance({ resourceLive: { schema: RESOURCE_LIVE_SCHEMA, readings: [reading] } }, at)
      .lanes.find(lane => lane.lane === 'claude')!;
    expect(claude(scopedReading()).windowStart).toBe(iso(-3_600_000));
    // No start on the reading is no start on the row: it is never derived from the reset.
    expect(claude(resourceLive().readings[0]!).windowStart).toBeNull();
    // A start at or after the reset describes no window.
    expect(claude({ ...scopedReading(), window_start: iso(3_600_000) }).windowStart).toBeNull();
    // A reading dated after now is not believed, so neither is its window.
    expect(claude({ ...scopedReading(), observed_at: iso(60_000) }).windowStart).toBeNull();
    expect(projectLaneAllowance({}, now).lanes.every(lane => lane.windowStart === null)).toBe(true);
  });
  it('verifies the Python dispatcher receipt against its weekly measurement and rejects altered scope', async () => {
    const fixtures = new URL('../contrib/mac/tests/fixtures/posture-provenance/', import.meta.url);
    const weekly = JSON.parse(await readFile(new URL('weekly-capacity.json', fixtures), 'utf8')) as DevinWeeklyCapacity;
    const row = JSON.parse(await readFile(new URL('work-market-posture.json', fixtures), 'utf8'));
    const at = Date.parse(weekly.observed_at!);
    const root = await mkdtemp(join(tmpdir(), 'producer-posture-'));
    try {
      await mkdir(join(root, 'metrics'));
      const project = async (entry: Record<string, unknown>) => {
        await writeFile(join(root, 'metrics/work-market.jsonl'), JSON.stringify({ ...row, lanes: { devin: entry } }) + '\n');
        return projectLaneAllowance({ weekly, posture: await postureEvidence(root) }, at).lanes.find(l => l.lane === 'devin')!.posture;
      };
      expect(await project(row.lanes.devin)).toBe('burn');
      for (const key of ['account_id', 'model', 'reset_at', 'window_start']) {
        expect(await project({ ...row.lanes.devin, [key]: 'mismatch' })).toBe('unknown');
      }
      for (const key of ['account_id', 'model', 'reset_at', 'window_start']) {
        const entry = { ...row.lanes.devin }; delete entry[key];
        expect(await project(entry)).toBe('unknown');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('preserves journal timestamp and scoped provenance without trusting it yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lane-provenance-'));
    try {
      await mkdir(join(root, 'metrics'));
      for (const event of ['posture', 'route_decision']) {
        await writeFile(join(root, 'metrics/work-market.jsonl'), JSON.stringify({ schema: 'work-market.v1', event, ts: now / 1000,
          [event === 'posture' ? 'lanes' : 'ranking_inputs']: { claude: { posture: 'burn', posture_reason: 'fixture',
            account_id: 'account-a', model: 'claude-opus', window_start: iso(-3_600_000), reset_at: iso(3_600_000) } } }));
        expect((await postureEvidence(root))?.lanes.claude).toMatchObject({ observedAt: iso(0), accountId: 'account-a',
          model: 'claude-opus', windowStart: iso(-3_600_000), resetAt: iso(3_600_000) });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('accepts only matching fresh scoped posture evidence', () => {
    const result = projectLaneAllowance({ resourceLive: { schema: RESOURCE_LIVE_SCHEMA, readings: [scopedReading()] },
      posture: { lanes: { claude: scopedPosture() } } }, now);
    expect(result.lanes[0]).toMatchObject({ posture: 'burn', costClass: 'included', projectedUnusedPct: 40, used: 62 });
  });
  it.each([
    { observedAt: iso(-900_001) }, { observedAt: iso(1) }, { observedAt: 'invalid' }, { observedAt: undefined },
    { accountId: 'account-b' }, { accountId: undefined }, { model: 'other-model' }, { model: undefined },
    { lane: 'devin' }, { resetAt: iso(7_200_000) }, { windowStart: iso(-7_200_000) },
  ])('ignores stale, future or mismatched posture: %j', (changes) => {
    const result = projectLaneAllowance({ resourceLive: { schema: RESOURCE_LIVE_SCHEMA, readings: [scopedReading()] },
      posture: { lanes: { claude: { ...scopedPosture(), ...changes } } } }, now);
    expect(result.lanes[0]).toMatchObject({ freshness: 'live', used: 62, posture: 'unknown', costClass: 'unknown', projectedUnusedPct: null });
  });
  it('does not infer API credit from a lane name with no readings', () => {
    expect(projectLaneAllowance({}, now).lanes.find(r => r.lane === 'claude-api')).toMatchObject({ costClass: 'unknown', used: null });
  });
  it.each([null, 0])('does not infer posture from an incomplete model count (used=%s)', (used) => {
    const result = projectLaneAllowance({ resourceLive: { schema: RESOURCE_LIVE_SCHEMA, readings: [{ ...scopedReading(), used, limit: null }] },
      posture: { lanes: { claude: scopedPosture() } } }, now);
    expect(result.lanes[0]).toMatchObject({ posture: 'unknown', usedPct: null, left: null });
  });
  it('rejects future weekly observations including their detail values', () => {
    const weekly = { used: 12, limit: 20, remaining: 8, limit_source: 'config', window_start: iso(-3_600_000), reset_at: iso(3_600_000),
      burn_rate_per_hour: 1, sessions: 2, source: 'devin-api-v3-sessions', observed_at: iso(1), state: 'live', reason: null } as const;
    expect(projectLaneAllowance({ weekly }, now).lanes.find(r => r.lane === 'devin')).toMatchObject({ used: null, limit: null,
      freshness: 'invalid-future', reason: 'invalid-future', ageSeconds: null, devin: { weeklyUsedAcu: null, weeklyAllowanceAcu: null } });
  });
  it.each([{}, { account_id: 'account-b', model: 'swe-2' }, { account_id: 'account-a', model: 'swe-2' }])(
    'never borrows weekly account scope from the sidecar: %j', (scope) => {
      const weekly = { used: 12, limit: 20, remaining: 8, limit_source: 'config', window_start: iso(-3_600_000), reset_at: iso(3_600_000),
        burn_rate_per_hour: 1, sessions: 2, source: 'devin-api-v3-sessions', observed_at: iso(0), state: 'live', reason: null, ...scope } as const;
      const result = projectLaneAllowance({ weekly, resourceLive: { schema: RESOURCE_LIVE_SCHEMA, readings: [{ ...scopedReading(), id: 'devin', model: 'swe-2' }] },
        posture: { lanes: { devin: { ...scopedPosture(), model: 'swe-2' } } } }, now);
      expect(result.lanes.find(r => r.lane === 'devin')).toMatchObject({ used: 12, limit: 20,
        posture: scope.account_id === 'account-a' ? 'burn' : 'unknown', costClass: scope.account_id === 'account-a' ? 'included' : 'unknown' });
    });
  it.each([
    {}, { observed_at: '2026-11-17T11:44:59.999Z' }, { observed_at: '2026-11-18T12:00:00.000Z' },
    { account_id: undefined }, { account_id: 'account-b' }, { model: 'swe-2' }, { model: undefined },
    { source: 'other-source' }, { verified: false }, { stale_after: '2026-11-17T11:59:59.999Z' }, { limit: 0 },
  ])('requires fresh account-scoped preview model evidence: %j', (changes) => {
    const at = Date.parse('2026-11-17T12:00:00.000Z');
    const snapshot = projectLaneAllowance({ resourceLive: { schema: RESOURCE_LIVE_SCHEMA, readings: [
      { ...resourceLive().readings[0], id: 'devin', account_id: 'account-a', observed_at: new Date(at).toISOString() },
      { id: 'devin-flash', verified: true, used: null, limit: 2, unit: 'models', reset_at: null,
        observed_at: new Date(at).toISOString(), source: 'devin-cli-models-list', source_tier: 'official', account_id: 'account-a', model: 'swe-2-flash', ...changes },
    ] } }, at);
    const expected = Object.keys(changes).length === 0;
    expect(snapshot.lanes.find(r => r.lane === 'devin')?.devin?.preview?.free).toBe(expected ? true : null);
  });
  it('ignores an ancient included/free-preview receipt when every reading is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lane-ancient-'));
    try {
      await mkdir(join(root, 'metrics'));
      await writeFile(join(root, 'metrics/work-market.jsonl'), JSON.stringify({ schema: 'work-market.v1', event: 'posture', ts: 1,
        lanes: { devin: { posture: 'burn', posture_reason: 'preview-expiring', cost_class: 'included', free_preview: true,
          preview_expires_at: iso(3_600_000) } } }));
      const snapshot = await readLaneAllowance({ runsDir: root, weeklyFile: join(root, 'missing'), nowMs: now });
      expect(snapshot.lanes.find(r => r.lane === 'devin')).toMatchObject({ freshness: 'unknown', used: null, limit: null,
        posture: 'unknown', costClass: 'unknown', devin: { inFlightReservations: null, preview: { free: false } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([1, 86_400_000])('rejects negative preview ages instead of granting free status (future offset %sms)', (offset) => {
    const beforeExpiry = Date.parse('2026-11-17T12:00:00.000Z');
    const snapshot = projectLaneAllowance({ resourceLive: { schema: RESOURCE_LIVE_SCHEMA, readings: [{
      id: 'devin-flash', verified: true, used: null, limit: 2, unit: 'models', reset_at: null,
      observed_at: new Date(beforeExpiry + offset).toISOString(), source: 'devin-cli-models-list', source_tier: 'official',
      account_id: 'account-a', model: 'swe-2-flash',
    }] } }, beforeExpiry);
    expect(snapshot.lanes.find(r => r.lane === 'devin-flash')).toMatchObject({ used: null, limit: null,
      freshness: 'invalid-future', ageSeconds: null, posture: 'unknown', costClass: 'unknown',
      reason: 'invalid-future', devin: { preview: { expired: false, free: null } } });
  });
  it('never grants free status from stale models after preview expiry, even with a receipt claiming an extension', () => {
    const snapshot = projectLaneAllowance({ resourceLive: { schema: RESOURCE_LIVE_SCHEMA, readings: [{
      id: 'devin-flash', verified: true, used: null, limit: 2, unit: 'models', reset_at: null,
      observed_at: iso(-3_600_000), source: 'devin-cli-models-list', source_tier: 'official',
      account_id: 'account-a', model: 'swe-2-flash',
    }] }, posture: { lanes: { 'devin-flash': { ...scopedPosture(), observedAt: iso(-3_600_000),
      model: 'swe-2-flash', windowStart: undefined, resetAt: DEVIN_FLASH_EXPIRES_AT,
      previewExpiresAt: iso(3_600_000), freePreview: true,
    } } } }, now);
    const lane = snapshot.lanes.find(r => r.lane === 'devin-flash');
    expect(lane).toMatchObject({ freshness: 'stale', used: null, limit: 2, posture: 'unknown', costClass: 'unknown',
      reason: 'reading-stale', devin: { preview: { expired: true, free: false, expiresAt: DEVIN_FLASH_EXPIRES_AT } } });
    expect(lane?.devin?.preview?.evidence).toBeUndefined();
  });
  it('projects a known reading without inventing missing values', () => {
    const value = projectLaneAllowance({ resourceLive: resourceLive() }, now);
    expect(value.lanes.find(r => r.lane === 'claude')).toMatchObject({ used: 62, left: 38, usedPct: 62, freshness: 'live', resetsInHours: 1, posture: 'unknown', postureReason: 'posture-unmeasured' });
    expect(value.lanes.find(r => r.lane === 'gemini')).toMatchObject({ used: null, limit: null, left: null, usedPct: null, freshness: 'unknown', reason: 'reading-missing' });
  });
  it('keeps stale values explicitly stale', () => {
    expect(projectLaneAllowance({ resourceLive: resourceLive(-3_600_000) }, now).lanes[0]).toMatchObject({ used: 62, freshness: 'stale', reason: 'reading-stale' });
  });
  it.each(['burn', 'preserve'] as const)('projects %s and tolerates absent preview fields', (posture) => {
    const result = projectLaneAllowance({ resourceLive: { schema: RESOURCE_LIVE_SCHEMA, readings: [{ ...resourceLive().readings[0],
      id: 'devin', account_id: 'account-a', model: 'swe-2', }] }, posture: { lanes: { devin: {
      posture, postureReason: 'fixture-reason', observedAt: iso(0), accountId: 'account-a', model: 'swe-2', resetAt: iso(3_600_000),
      projectedUnusedPct: 40, hoursToReset: 1, allowance: { in_flight: 2 } } } } }, now);
    expect(result.lanes.find(r => r.lane === 'devin')).toMatchObject({ posture, postureReason: 'fixture-reason', costClass: 'unknown', devin: { inFlightReservations: 2, preview: { expired: true, free: false } } });
  });
  it('uses weekly ACUs and marks expired previews', () => {
    const weekly = { used: 12, limit: 20, remaining: 8, limit_source: 'config', window_start: iso(-3_600_000), reset_at: iso(3_600_000),
      burn_rate_per_hour: 1, sessions: 2, source: 'devin-api-v3-sessions', observed_at: iso(0), state: 'live', reason: null } as const;
    expect(projectLaneAllowance({ weekly }, now).lanes.find(r => r.lane === 'devin')).toMatchObject({ used: 12, limit: 20, left: 8, unit: 'acu', devin: { weeklyUsedAcu: 12, weeklyAllowanceAcu: 20, preview: { expired: true } } });
  });
  it('reads injected paths and handles missing or malformed files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lane-allowance-'));
    try {
      const deps = { runsDir: root, weeklyFile: join(root, 'weekly.json'), nowMs: now };
      expect((await readLaneAllowance(deps)).lanes[0]?.used).toBeNull();
      await mkdir(join(root, 'state'));
      await writeFile(join(root, 'state/resource-live.json'), '{broken');
      expect((await readLaneAllowance(deps)).lanes[0]?.reason).toBe('reading-missing');
      await writeFile(join(root, 'state/resource-live.json'), JSON.stringify(resourceLive()));
      expect((await readLaneAllowance(deps)).lanes[0]?.used).toBe(62);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('returns the read projection through the API', async () => {
    const req = new EventEmitter() as IncomingMessage;
    req.url = '/api/usage/lanes'; req.method = 'GET'; req.headers = {};
    let code = 0, body = '';
    const res = { writeHead(status: number) { code = status; }, end(value: string) { body = value; } } as unknown as ServerResponse;
    await handleApi(req, res, { roots: [], models: {}, telemetry: {}, tools: {} } as unknown as AshlrConfig, { token: 'unused', allowDispatch: false });
    expect(code).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ v: 1, lanes: expect.any(Array) });
  });
  it('reads optional router preview evidence without assuming unknown cost classes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lane-posture-'));
    const at = Date.parse('2026-11-17T12:00:00.000Z');
    const expiry = new Date(at + 3_600_000).toISOString();
    try {
      await mkdir(join(root, 'metrics'));
      await mkdir(join(root, 'state'));
      await writeFile(join(root, 'state/resource-live.json'), JSON.stringify({ schema: RESOURCE_LIVE_SCHEMA, readings: [
        { ...resourceLive().readings[0], id: 'devin', account_id: 'account-a', model: 'swe-2', observed_at: new Date(at).toISOString(), reset_at: expiry },
        { id: 'devin-flash', verified: true, used: null, limit: 2, unit: 'models', reset_at: null,
          observed_at: new Date(at).toISOString(), source: 'devin-cli-models-list', source_tier: 'official', account_id: 'account-a', model: 'swe-2-flash' },
      ] }));
      await writeFile(join(root, 'metrics/work-market.jsonl'), JSON.stringify({ schema: 'work-market.v1', event: 'posture', ts: at / 1000, lanes: {
        devin: { posture: 'burn', posture_reason: 'preview-expiring', cost_class: 'future-class', free_preview: true, preview_expires_at: expiry,
          account_id: 'account-a', model: 'swe-2', reset_at: expiry },
      } }));
      const snapshot = await readLaneAllowance({ runsDir: root, weeklyFile: join(root, 'missing'), nowMs: at });
      expect(snapshot.lanes.find(r => r.lane === 'devin')).toMatchObject({ costClass: 'unknown', devin: { preview: { free: true, expired: false, expiresAt: expiry } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
