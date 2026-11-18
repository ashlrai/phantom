/** POST /api/verse/fleet/coordination-claims/claim with an optional `thread`
 * binds the claim to its Slack thread. All seams injected; fake ids only. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VERSE_FLEET_COORDINATION_CLAIM_PATH as CLAIM,
  createFleetCoordinationMutateApi,
  type FleetCoordinationMutateApiDeps,
} from '../src/core/verse/fleet-coordination-mutate-api.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { readClaimThreadBindings } from '../src/core/fleet/claim-notice-send.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const LEASE = '00000000-0000-4000-8000-000000000447';
const SLASH = 'T0FAKE01/C0FAKE01/1700000000.000100';
const COLON = 'slack:T0FAKE01:C0FAKE01:1700000000.000100';
const NOW = 1_700_000_000_000;
const okClaim: NonNullable<FleetCoordinationMutateApiDeps['claim']> = (i, now) => ({
  ok: true,
  value: { lease: LEASE, claim: { id: 'claim-fake-1', repo: i.repo, task: i.task, agent: i.agent, claimedAt: now, expiresAt: now + 60_000 } },
} as never);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function post(deps: FleetCoordinationMutateApiDeps, body: unknown) {
  const api = createFleetCoordinationMutateApi({ now: () => new Date(NOW), ...deps });
  let status = 0; let text = '';
  const res = { writeHead(c: number) { status = c; return this; }, end(b: string) { text = b; } } as unknown as ServerResponse;
  const req = Object.assign(new EventEmitter(), { url: CLAIM }) as unknown as IncomingMessage;
  const pending = api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, CLAIM, 'POST');
  await Promise.resolve();
  req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
  req.emit('end');
  await pending;
  return { status, text, body: JSON.parse(text) };
}
const base = { repo: 'example/repo', task: 'ship it', agent: 'dot-example' };

describe('claim route thread binding (447C)', () => {
  it.each([SLASH, COLON])('binds a valid thread (%s) after the claim', async (thread) => {
    const bind = vi.fn((b, _n) => ({ ok: true as const, status: 'bound' as const, binding: b }));
    const r = await post({ claim: okClaim, bind }, { ...base, thread });
    expect(r.status).toBe(200);
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind.mock.calls[0]![0]).toEqual({ claimId: 'claim-fake-1', repo: 'example/repo', threadKey: thread });
    expect(bind.mock.calls[0]![1]).toBe(NOW);
    expect(r.body.threadBinding).toEqual({ ok: true, status: 'bound' });
    expect(r.body.lease).toBe(LEASE);
  });

  it.each([
    ['invalid thread', { thread: 'not-a-thread' }],
    ['non-string thread', { thread: 42 }],
    ['unknown key', { thread: SLASH, extra: 1 }],
  ])('%s → 400, no claim, no bind', async (_n, extra) => {
    const claim = vi.fn(okClaim); const bind = vi.fn();
    const r = await post({ claim, bind }, { ...base, ...extra });
    expect(r.status).toBe(400);
    expect(r.body.outcome).toBe('invalid-input');
    expect(claim).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it('bind refusal keeps the lease and reports ok:false', async () => {
    const r = await post({ claim: okClaim, bind: () => ({ ok: false, kind: 'refused', reason: 'bindings-at-capacity' }) }, { ...base, thread: SLASH });
    expect(r.status).toBe(200);
    expect(r.body.lease).toBe(LEASE);
    expect(r.body.threadBinding).toEqual({ ok: false, reason: 'bindings-at-capacity' });
  });

  it('a throwing bind is masked as bind-threw', async () => {
    const r = await post({ claim: okClaim, bind: () => { throw new Error('SECRET-DISK-PATH /etc/x'); } }, { ...base, thread: SLASH });
    expect(r.status).toBe(200);
    expect(r.body.lease).toBe(LEASE);
    expect(r.body.threadBinding).toEqual({ ok: false, reason: 'bind-threw' });
    expect(r.text).not.toContain('SECRET-DISK-PATH');
  });

  it('a failed claim never binds', async () => {
    const bind = vi.fn();
    const r = await post({ claim: () => ({ ok: false, error: 'duplicate' }), bind }, { ...base, thread: SLASH });
    expect(r.status).toBe(409);
    expect(bind).not.toHaveBeenCalled();
  });

  it('without thread there is no threadBinding key and bind is not called', async () => {
    const bind = vi.fn();
    const r = await post({ claim: okClaim, bind }, base);
    expect(r.status).toBe(200);
    expect('threadBinding' in r.body).toBe(false);
    expect(Object.keys(r.body).sort()).toEqual(['claim', 'lease', 'ok', 'outcome']);
    expect(bind).not.toHaveBeenCalled();
  });

  it('round trip: the real writer on a temp path is readable by the notice reader', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claim-thread-447c-')); dirs.push(dir);
    const path = join(dir, 'runs', 'claim-thread-bindings.jsonl');
    const r = await post({ claim: okClaim, bind: (b, n) => appendClaimThreadBinding(path, b, n) }, { ...base, thread: COLON });
    expect(r.body.threadBinding).toEqual({ ok: true, status: 'bound' });
    expect(readClaimThreadBindings(path)).toEqual([{ claimId: 'claim-fake-1', repo: 'example/repo', threadKey: COLON }]);
  });
});
