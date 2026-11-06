import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildFleetHop,
  emitFleetHop,
  fleetHopInsertId,
  replayFleetHopSpool,
  runFleetHopCli,
} from '../src/core/observability/fleet-hop.js';

const FAKE_KEY = `phc_test_${Math.random().toString(36).slice(2)}`;
const fixture = readFileSync(join(__dirname, 'fixtures', 'fleet-hop-replay.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

let dir: string;
let spoolPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-hop-'));
  spoolPath = join(dir, 'spool.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function recorder(status = 200) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('{}', { status });
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

describe('fleet_hop queue.v1 schema', () => {
  it('matches the golden event', () => {
    const ev = buildFleetHop(fixture[1]);
    expect(ev).toEqual({
      event: 'fleet_hop',
      distinct_id: 'station:publish',
      timestamp: '2026-10-26T06:02:30Z',
      properties: {
        schema: 'queue.v1',
        job_id: 'RQ-QUEUE-1',
        station: 'publish',
        pool: 'codex-cmp',
        tier: 'work',
        node: 'mac',
        engine: 'codex',
        job: null,
        agent: null,
        repo: null,
        pr: 951,
        enter_ts: '2026-10-26T06:01:00Z',
        exit_ts: '2026-10-26T06:02:30Z',
        tokens: 1200,
        usd: 0.04,
        duration_s: 90,
        test: false,
        source: 'agent_fleet',
        $process_person_profile: false,
        $insert_id: fleetHopInsertId('RQ-QUEUE-1', 951, 'publish', '2026-10-26T06:01:00Z'),
      },
    });
  });

  it('drops hops with no station or enter_ts', () => {
    expect(buildFleetHop(fixture[3])).toBeNull();
    expect(buildFleetHop({ station: 'ci' })).toBeNull();
  });

  it('never carries bodies, prompts, paths or unknown fields', () => {
    const ev = buildFleetHop({
      ...fixture[0],
      agent: '/Users/someone/.codex/auth.json',
      repo: 'rm -rf $HOME',
      prompt: 'secret prompt',
      body: 'pr body',
      api_key: FAKE_KEY,
    } as never);
    const text = JSON.stringify(ev);
    for (const bad of ['/Users', 'auth.json', 'rm -rf', 'secret prompt', 'pr body', FAKE_KEY]) {
      expect(text).not.toContain(bad);
    }
    expect(ev?.properties.agent).toBeNull();
    expect(ev?.properties.repo).toBeNull();
  });
});

describe('fleet_hop delivery', () => {
  it('replays the fixture: sends valid hops and drops invalid ones', async () => {
    const { bodies, fetchImpl } = recorder();
    const env = { POSTHOG_AGENT_FLEET_TOKEN: FAKE_KEY };
    const results = [];
    for (const hop of fixture) results.push(await emitFleetHop(hop, { env, fetchImpl, spoolPath }));
    expect(results.map((r) => r.sent)).toEqual([true, true, true, false]);
    expect(results[3].dropped).toBe(true);
    expect(bodies.map((b) => (b.properties as Record<string, unknown>).station)).toEqual(['claimed', 'publish', 'publish']);
    expect(existsSync(spoolPath)).toBe(false);
  });

  it('gives retries of one hop the same $insert_id and dedups them on replay', async () => {
    const a = buildFleetHop(fixture[1])!;
    const b = buildFleetHop(fixture[2])!;
    expect(a.properties.$insert_id).toBe(b.properties.$insert_id);
    expect(a.properties.$insert_id).toMatch(/^[0-9a-f]{32}$/);

    for (const hop of fixture) await emitFleetHop(hop, { env: {}, spoolPath });
    const { bodies, fetchImpl } = recorder();
    const out = await replayFleetHopSpool({ env: { POSTHOG_AGENT_FLEET_TOKEN: FAKE_KEY }, fetchImpl, spoolPath });
    expect(out).toEqual({ sent: 2, kept: 0, duplicates: 1 });
    expect(bodies).toHaveLength(2);
    expect(readFileSync(spoolPath, 'utf8')).toBe('');
  });

  it('spools on endpoint failure, timeout-style errors and missing key, and never throws', async () => {
    const failing = recorder(503);
    const r1 = await emitFleetHop(fixture[0], { env: { POSTHOG_AGENT_FLEET_TOKEN: FAKE_KEY }, fetchImpl: failing.fetchImpl, spoolPath });
    expect(r1).toEqual({ sent: false, spooled: true, dropped: false, detail: 'HTTP 503' });

    const throwing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const r2 = await emitFleetHop(fixture[1], { env: { POSTHOG_AGENT_FLEET_TOKEN: FAKE_KEY }, fetchImpl: throwing, spoolPath });
    expect(r2.spooled).toBe(true);
    expect(r2.detail).toBe('network error');

    const r3 = await emitFleetHop(fixture[0], { env: {}, spoolPath });
    expect(r3.detail).toBe('no key');

    const spool = readFileSync(spoolPath, 'utf8');
    expect(spool.trim().split('\n')).toHaveLength(3);
    expect(spool).not.toContain(FAKE_KEY);
    expect(spool).not.toContain('api_key');
  });

  it('CLI exits 0 on bad input and on unwritable spool', async () => {
    expect(await runFleetHopCli([], 'not json', { env: {}, spoolPath })).toBe(0);
    writeFileSync(join(dir, 'file'), 'x');
    const bad = join(dir, 'file', 'nested', 'spool.jsonl');
    expect(await runFleetHopCli([], JSON.stringify(fixture[0]), { env: {}, spoolPath: bad })).toBe(0);
    expect(await runFleetHopCli(['--replay'], '', { env: {}, spoolPath: bad })).toBe(0);
  });
});
