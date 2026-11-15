/** POST /api/verse/fleet/coordination-claims/{claim,return} — the off-host
 * advisory claim/return route. Real ledger in a temp dir via
 * PHANTOM_FLEET_LEDGER_PATH (never ~/.ashlr); fake agents and ids only. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VERSE_FLEET_COORDINATION_CLAIMS_PATH as CLAIMS,
  createFleetCoordinationClaimsApi,
} from '../src/core/verse/fleet-coordination-claims-api.js';
import {
  COORDINATION_MUTATE_MAX_BODY_BYTES,
  VERSE_FLEET_COORDINATION_CLAIM_PATH as CLAIM,
  VERSE_FLEET_COORDINATION_RETURN_PATH as RETURN,
  createFleetCoordinationMutateApi,
} from '../src/core/verse/fleet-coordination-mutate-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const AGENT = 'dot-example';
const HEAD = 'deadbeefcafe';
let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coord-mutate-376-'));
  previous = process.env['PHANTOM_FLEET_LEDGER_PATH'];
  process.env['PHANTOM_FLEET_LEDGER_PATH'] = join(dir, 'coordination.jsonl');
});
afterEach(() => {
  if (previous === undefined) delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
  else process.env['PHANTOM_FLEET_LEDGER_PATH'] = previous;
  rmSync(dir, { recursive: true, force: true });
});

async function call(api: ApiModule, method: string, path: string, raw?: string) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const req = Object.assign(new EventEmitter(), { url: path }) as unknown as IncomingMessage;
  const pending = api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, path, method);
  if (raw !== undefined) {
    await Promise.resolve();
    req.emit('data', Buffer.from(raw, 'utf8'));
    req.emit('end');
  }
  const handled = await pending;
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

const post = (api: ApiModule, path: string, body: unknown) =>
  call(api, 'POST', path, typeof body === 'string' ? body : JSON.stringify(body));

async function claimed(api: ApiModule, task = 'ship the example') {
  const r = await post(api, CLAIM, { repo: 'example/repo', task, agent: AGENT, ttlSeconds: 600 });
  expect(r.status).toBe(200);
  return { id: r.body.claim.id as string, lease: r.body.lease as string, r };
}

describe('coordination-claims claim/return over HTTP (real ledger)', () => {
  it('claims, returns a PR result, and the GET view drops the claim; no lease leaks', async () => {
    const api = createFleetCoordinationClaimsApi();
    const { id, lease, r } = await claimed(api);
    expect(r.body).toMatchObject({ ok: true, outcome: 'claimed', claim: { id, repo: 'example/repo', task: 'ship the example', agent: AGENT } });
    expect(Object.keys(r.body.claim).sort()).toEqual(['agent', 'claimedAt', 'expiresAt', 'id', 'repo', 'task']);
    expect(Date.parse(r.body.claim.expiresAt) - Date.parse(r.body.claim.claimedAt)).toBe(600_000);
    expect(lease).toMatch(/^[0-9a-f-]{36}$/);

    const listed = await call(api, 'GET', CLAIMS);
    expect(listed.body.claims.map((c: { id: string }) => c.id)).toEqual([id]);
    expect(listed.text).not.toContain(lease);

    const dup = await post(api, CLAIM, { repo: 'example/repo', task: 'ship the example', agent: 'other-example' });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ ok: false, outcome: 'duplicate' });

    const ret = await post(api, RETURN, { claimId: id, agent: AGENT, lease, result: { pr: 42, head: HEAD } });
    expect(ret.status).toBe(200);
    expect(ret.body).toMatchObject({ ok: true, outcome: 'returned', claimId: id, message: { id: `return-${id}`, from: AGENT, to: 'all' } });
    expect(ret.body.message.body).toContain(`pr #42 head ${HEAD}`);
    expect(ret.text).not.toContain(lease);
    expect(ret.text).not.toMatch(/lease/i);

    const after = await call(api, 'GET', CLAIMS);
    expect(after.body.claims).toEqual([]);
    expect(after.text).not.toContain(lease);

    const again = await post(api, RETURN, { claimId: id, agent: AGENT, lease, result: { pr: 42, head: HEAD } });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('already-returned');
    expect(again.text).not.toContain(lease);
  });

  it('wrong lease → 403 and the claim is still held', async () => {
    const api = createFleetCoordinationClaimsApi();
    const { id, lease } = await claimed(api);
    const wrong = 'not-the-lease-example';
    const r = await post(api, RETURN, { claimId: id, agent: AGENT, lease: wrong, result: { tests: 'all green' } });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, outcome: 'not-owner', claimId: id });
    expect(r.text).not.toContain(lease);
    expect(r.text).not.toContain(wrong);
    const spoof = await post(api, RETURN, { claimId: id, agent: 'other-example', lease, result: { blocked: 'x' } });
    expect(spoof.status).toBe(403);
    const listed = await call(api, 'GET', CLAIMS);
    expect(listed.body.claims.map((c: { id: string }) => c.id)).toEqual([id]);
  });

  it('missing claim → 404 on an existing ledger (a never-created ledger reads as unknown → 503)', async () => {
    const absent = await post(createFleetCoordinationClaimsApi(), RETURN,
      { claimId: 'claim-missing-example', agent: AGENT, lease: 'lease-example', result: { artifact: 'out.txt' } });
    expect(absent.status).toBe(503);
    writeFileSync(process.env['PHANTOM_FLEET_LEDGER_PATH']!, '', { mode: 0o600 });
    const r = await post(createFleetCoordinationClaimsApi(), RETURN,
      { claimId: 'claim-missing-example', agent: AGENT, lease: 'lease-example', result: { artifact: 'out.txt' } });
    expect(r.status).toBe(404);
    expect(r.body.outcome).toBe('not-found');
  });

  it('rejects bad shapes with 400, oversize with 413 and wrong methods with 405', async () => {
    const api = createFleetCoordinationClaimsApi();
    const { id, lease } = await claimed(api);
    const base = { claimId: id, agent: AGENT, lease };
    const bad: Array<[string, unknown]> = [
      [CLAIM, { repo: 'example/repo', task: 't', agent: AGENT, extra: 1 }],
      [CLAIM, { repo: 'example/repo', task: 't', agent: AGENT, ttlSeconds: 0 }],
      [CLAIM, { repo: 'example/repo', task: 't', agent: AGENT, ttlSeconds: 604_801 }],
      [CLAIM, { repo: 'example/repo', task: 't', agent: AGENT, ttlSeconds: 1.5 }],
      [CLAIM, { repo: 'not-a-repo', task: 't', agent: AGENT }],
      [CLAIM, { repo: 'example/repo', task: 't', agent: 7 }],
      [CLAIM, 'not json'],
      [CLAIM, [1]],
      [RETURN, { ...base, result: { pr: 1, head: HEAD }, extra: true }],
      [RETURN, { ...base, result: { pr: 1, head: HEAD, tests: 'green' } }],
      [RETURN, { ...base, result: { tests: 'green', blocked: 'x' } }],
      [RETURN, { ...base, result: { pr: 1 } }],
      [RETURN, { ...base, result: { pr: 1, head: 'zz' } }],
      [RETURN, { ...base, result: { verdict: 'ok' } }],
      [RETURN, { ...base, result: { tests: 5 } }],
      [RETURN, { ...base, result: {} }],
      [RETURN, { ...base, result: { tests: 'g' }, ttlSeconds: -1 }],
    ];
    for (const [path, body] of bad) {
      const r = await post(api, path, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.outcome).toBe('invalid-input');
      expect(r.text).not.toContain(lease);
    }
    const big = await post(api, RETURN, { ...base, result: { tests: 'x'.repeat(9 * 1024) } });
    expect(big.status).toBe(413);
    expect(big.text).not.toContain(lease);
    expect(9 * 1024).toBeGreaterThan(COORDINATION_MUTATE_MAX_BODY_BYTES);
    for (const path of [CLAIM, RETURN]) {
      const r = await call(api, 'GET', path);
      expect(r.handled).toBe(true);
      expect(r.status).toBe(405);
    }
    // None of the rejected requests released the claim.
    const listed = await call(api, 'GET', CLAIMS);
    expect(listed.body.claims.map((c: { id: string }) => c.id)).toEqual([id]);
  });

  it('GET claims output on an empty ledger is byte-identical with and without the chain', async () => {
    writeFileSync(process.env['PHANTOM_FLEET_LEDGER_PATH']!, '', { mode: 0o600 });
    const now = () => new Date('2026-11-14T12:00:00.000Z');
    const unchained = createFleetCoordinationClaimsApi({ now, mutate: async () => false });
    const chained = createFleetCoordinationClaimsApi({ now });
    const before = await call(unchained, 'GET', CLAIMS);
    const after = await call(chained, 'GET', CLAIMS);
    expect(after.status).toBe(200);
    expect(after.text).toBe(before.text);
    expect(after.text).toBe('{"v":1,"generatedAt":"2026-11-14T12:00:00.000Z","source":"coordination-ledger","state":"known","claims":[],"expiredClaims":0}');
  });
});

describe('coordination mutate api status mapping (seams)', () => {
  it('maps claim errors and return outcomes, including released-unposted → 202', async () => {
    const now = () => new Date(1_000);
    for (const [error, status] of [['unavailable', 503], ['not-owner', 403], ['not-found', 404], ['invalid-input', 400]] as const) {
      const api = createFleetCoordinationMutateApi({ now, claim: () => ({ ok: false, error }) });
      const r = await post(api, CLAIM, { repo: 'example/repo', task: 't', agent: AGENT });
      expect(r.status).toBe(status);
    }
    const thrower = createFleetCoordinationMutateApi({ claim: () => { throw new Error('boom'); } });
    expect((await post(thrower, CLAIM, { repo: 'example/repo', task: 't', agent: AGENT })).status).toBe(503);

    const seen: unknown[] = [];
    const unposted = createFleetCoordinationMutateApi({
      now,
      return: (input, at) => {
        seen.push({ ...input, at });
        return { ok: false, outcome: 'released-unposted', claimId: input.id, id: `return-${input.id}`, body: 'RESULT VERIFIED' };
      },
    });
    const r = await post(unposted, RETURN, { claimId: 'c-example', agent: AGENT, lease: 'lease-example', result: { pr: '7', head: HEAD }, ttlSeconds: 60 });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: false, outcome: 'released-unposted', claimId: 'c-example', id: 'return-c-example', body: 'RESULT VERIFIED' });
    expect(seen).toEqual([{ id: 'c-example', agent: AGENT, lease: 'lease-example', pr: '7', head: HEAD,
      tests: undefined, artifact: undefined, blocked: undefined, ttlMs: 60_000, at: 1_000 }]);

    const down = createFleetCoordinationMutateApi({ return: (input) => ({ ok: false, outcome: 'unavailable', claimId: input.id }) });
    expect((await post(down, RETURN, { claimId: 'c', agent: AGENT, lease: 'l', result: { blocked: 'dep' } })).status).toBe(503);
    expect(await createFleetCoordinationMutateApi()({ cfg: {}, allowDispatch: true } as VerseApiContext,
      {} as IncomingMessage, {} as ServerResponse, CLAIMS, 'GET')).toBe(false);
  });
});
