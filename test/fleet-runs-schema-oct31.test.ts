import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createFleetRunsApi, type FleetRunsApiDeps } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

type Schema = { type?: string | string[]; const?: unknown; enum?: unknown[]; required?: string[];
  properties?: Record<string, Schema>; additionalProperties?: boolean; items?: Schema };
const schema: Schema & { $schema: string } = JSON.parse(readFileSync(new URL('../schema/fleet-runs.v1.schema.json', import.meta.url), 'utf8'));

// The published schema uses only these draft-07 keywords; reject unknown validation
// keywords so a future schema change cannot silently escape this test.
function validates(value: unknown, rule: Schema): boolean {
  const allowed = ['$schema', '$id', 'title', 'description', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items'];
  if (Object.keys(rule).some(k => !allowed.includes(k))) throw new Error('Unsupported schema keyword');
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (rule.type && !(Array.isArray(rule.type) ? rule.type : [rule.type]).includes(type)) return false;
  if ('const' in rule && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (Array.isArray(value) && rule.items && !value.every(item => validates(item, rule.items!))) return false;
  if (type === 'object') {
    const object = value as Record<string, unknown>;
    if (rule.required?.some(key => !Object.hasOwn(object, key))) return false;
    if (rule.additionalProperties === false && Object.keys(object).some(key => !Object.hasOwn(rule.properties ?? {}, key))) return false;
    for (const [key, child] of Object.entries(rule.properties ?? {})) {
      if (Object.hasOwn(object, key) && !validates(object[key], child)) return false;
    }
  }
  return true;
}

const at = '2026-01-01T00:00:00.000Z';
const healthy: FleetRunsApiDeps = {
  now: () => Date.parse(at),
  readRunsDir: async () => ({ lastTick: at, paused: false, memFreePct: 42, diskFreeGb: 10, switches: ['fake-switch'], claudeLane: 'fake-lane',
    lanes: [{ lane: 'fake-lane', running: 1, target: 2, queued: 3, held: false, heldReason: null, tokensLastHour: 4, merged24h: 5, mergeRate24h: 0.5 }],
    claimed: [{ job: 'fake-queued', lane: 'fake-lane', tier: 'fake-tier', at }],
    publishesLastHour: [{ job: 'fake-job', lane: null, url: null, at }], events: [{ at, kind: 'fake', text: 'example' }],
    drop: { pending: [{ lane: 'fake-lane', file: 'fake.md' }], done: 1 } }),
  listWorkers: async () => ({ workers: [{ job: 'fake-job', repo: 'fake/repo', lane: 'fake-lane', tier: 'fake-tier', ageSeconds: 1 }],
    leaders: [{ label: 'fake-leader', ageSeconds: null }], orchestratorAgents: 1 }),
  readInbox: async () => [{ at, source: 'fake-source', text: 'example' }],
  codexPersonal: async () => ({ usedPct: 1, resetsAt: null, asOf: at }),
  mergedLastHour: async () => ({ count: 1, items: [{ repo: 'fake/repo', number: 1, title: 'example' }] }),
};
async function snapshot(deps: FleetRunsApiDeps): Promise<Record<string, unknown>> {
  const req = Readable.from([]) as unknown as IncomingMessage;
  let status = 0;
  let body = '';
  const res = { writeHead(code: number) { status = code; }, end(text: string) { body = text; } } as unknown as ServerResponse;
  const handled = await createFleetRunsApi(deps)({} as VerseApiContext, req, res, VERSE_FLEET_RUNS_PATH, 'GET');
  expect(handled).toBe(true);
  expect(status).toBe(200);
  return JSON.parse(body);
}

describe('fleet runs JSON Schema', () => {
  it('parses as a closed draft-07 object', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.additionalProperties).toBe(false);
  });
  it('validates a healthy snapshot produced by the handler', async () => {
    const value = await snapshot(healthy);
    expect(Object.values(value.sources as object)).toEqual(Array(5).fill('healthy'));
    expect(validates(value, schema)).toBe(true);
    expect(validates({ ...value, extra: true }, schema)).toBe(false);
    expect(validates({ ...value, claimed: [{ job: 'fake-queued' }] }, schema)).toBe(false);
    const lane = { ...(value.lanes as Record<string, unknown>[])[0] };
    delete lane.held;
    expect(validates({ ...value, lanes: [lane] }, schema)).toBe(false);
    expect(validates({ ...value, v: 2 }, schema)).toBe(false);
  });
  it('validates the handler fallback when every source fails', async () => {
    const fail = async () => { throw new Error('fake failure'); };
    const value = await snapshot({ now: healthy.now, readRunsDir: fail, listWorkers: fail, readInbox: fail, codexPersonal: fail, mergedLastHour: fail });
    expect(value).toMatchObject({ sources: { runsDir: 'degraded', workers: 'degraded', inbox: 'degraded', codex: 'degraded', merges: 'degraded' },
      lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, claudeLane: null, orchestratorAgents: null,
      switches: [], lanes: [], workers: [], leaders: [], publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], inbox: [], drop: null, codexPersonal: null });
    expect(validates(value, schema)).toBe(true);
  });
});
