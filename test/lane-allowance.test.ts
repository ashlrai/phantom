import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectLaneAllowance, readLaneAllowance } from '../src/core/usage/lane-allowance.js';
import { RESOURCE_LIVE_SCHEMA } from '../src/core/usage/resource-live/types.js';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi } from '../src/core/web/api.js';
import type { AshlrConfig } from '../src/core/types.js';

const now = Date.parse('2026-12-02T00:00:00.000Z');
const iso = (offset: number) => new Date(now + offset).toISOString();
const resourceLive = (offset = 0) => ({ schema: RESOURCE_LIVE_SCHEMA, readings: [{ id: 'claude-weekly', verified: true,
  used: 62, limit: 100, unit: 'percent', reset_at: iso(3_600_000), observed_at: iso(offset), source: 'fixture', source_tier: 'official' }] });
describe('lane allowance', () => {
  it('projects a known reading without inventing missing values', () => {
    const value = projectLaneAllowance({ resourceLive: resourceLive() }, now);
    expect(value.lanes.find(r => r.lane === 'claude')).toMatchObject({ used: 62, left: 38, usedPct: 62, freshness: 'live', resetsInHours: 1, posture: 'unknown', postureReason: 'posture-unmeasured' });
    expect(value.lanes.find(r => r.lane === 'gemini')).toMatchObject({ used: null, limit: null, left: null, usedPct: null, freshness: 'unknown', reason: 'reading-missing' });
  });
  it('keeps stale values explicitly stale', () => {
    expect(projectLaneAllowance({ resourceLive: resourceLive(-3_600_000) }, now).lanes[0]).toMatchObject({ used: 62, freshness: 'stale', reason: 'reading-stale' });
  });
  it.each(['burn', 'preserve'] as const)('projects %s and tolerates absent preview fields', (posture) => {
    const result = projectLaneAllowance({ posture: { lanes: { devin: { posture, postureReason: 'fixture-reason', projectedUnusedPct: 40, hoursToReset: 1, allowance: { in_flight: 2 } } } } }, now);
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
    try {
      await mkdir(join(root, 'metrics'));
      await writeFile(join(root, 'metrics/work-market.jsonl'), JSON.stringify({ schema: 'work-market.v1', event: 'posture', lanes: {
        devin: { posture: 'burn', posture_reason: 'preview-expiring', cost_class: 'future-class', free_preview: true, preview_expires_at: iso(3_600_000) },
      } }));
      const snapshot = await readLaneAllowance({ runsDir: root, weeklyFile: join(root, 'missing'), nowMs: now });
      expect(snapshot.lanes.find(r => r.lane === 'devin')).toMatchObject({ costClass: 'unknown', devin: { preview: { free: true, expired: false, expiresAt: iso(3_600_000) } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
