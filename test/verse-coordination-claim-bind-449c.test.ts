/** POST /api/verse/fleet/coordination-claims/bind: bind a live, unbound claim.
 * Seams and a temp dir only; fake Slack ids. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VERSE_FLEET_COORDINATION_BIND_PATH as BIND,
  createFleetCoordinationMutateApi,
  type FleetCoordinationMutateApiDeps,
} from '../src/core/verse/fleet-coordination-mutate-api.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = 1_700_000_000_000;
const T1 = 'T00000000/C00000000/1700000000.000100';
const T2 = 'slack:T00000000:C00000000:1700000000.000200';
const claim = (id: string, expiresAt = NOW + 60_000) => ({ id, repo: 'example/repo', task: 't', agent: 'a', claimedAt: NOW - 1000, expiresAt });
const board = (claims = [claim('claim-fake-1')]): FleetBoard =>
  ({ schema: 'fleet.coordination.v1', state: 'known', claims, messages: [], proposals: [], expiredClaims: 0 } as FleetBoard);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function call(deps: FleetCoordinationMutateApiDeps, body: unknown, method = 'POST') {
  const api = createFleetCoordinationMutateApi({ now: () => new Date(NOW), ...deps });
  let status = 0; let text = '';
  const res = { writeHead(c: number) { status = c; return this; }, end(b: string) { text = b; } } as unknown as ServerResponse;
  const req = Object.assign(new EventEmitter(), { url: BIND }) as unknown as IncomingMessage;
  const pending = api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, BIND, method);
  await Promise.resolve();
  req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
  req.emit('end');
  await pending;
  return { status, text, body: JSON.parse(text) as Record<string, unknown> };
}
const req0 = { claimId: 'claim-fake-1', repo: 'example/repo', thread: T1 };
const noLeakOrPath = (text: string) => { expect(text.toLowerCase()).not.toContain('lease'); expect(text).not.toMatch(/\/(Users|home|tmp|var)\//); };

describe('claim bind route (449C)', () => {
  it('binds, then reports unchanged on repeat, then rebound for a new thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bind-449c-')); dirs.push(dir);
    const file = join(dir, 'bindings.jsonl');
    const deps = { readBoard: () => board(), bind: (b: never, n: number) => appendClaimThreadBinding(file, b, n) };
    const a = await call(deps, req0);
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ ok: true, outcome: 'bound', binding: { claimId: 'claim-fake-1', repo: 'example/repo', threadKey: T1 } });
    expect((await call(deps, req0)).body['outcome']).toBe('unchanged');
    const c = await call(deps, { ...req0, thread: T2 });
    expect(c.body['outcome']).toBe('rebound');
    for (const r of [a, c]) noLeakOrPath(r.text);
  });

  it('404s an unknown, expired or wrong-repo claim without binding', async () => {
    const bind = vi.fn();
    const deps = { readBoard: () => board([claim('claim-fake-1'), claim('claim-fake-old', NOW - 1)]), bind };
    for (const b of [{ ...req0, claimId: 'claim-guess' }, { ...req0, claimId: 'claim-fake-old' }, { ...req0, repo: 'example/other' }]) {
      const r = await call(deps, b);
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ ok: false, outcome: 'not-found' });
      noLeakOrPath(r.text);
    }
    expect(bind).not.toHaveBeenCalled();
  });

  it('503s an unreadable or throwing board and a refused or throwing bind', async () => {
    const unknown = { ...board(), state: 'unknown', claims: [] } as FleetBoard;
    const cases: FleetCoordinationMutateApiDeps[] = [
      { readBoard: () => unknown },
      { readBoard: () => { throw new Error('/Users/x/ledger'); } },
      { readBoard: () => board(), bind: () => ({ ok: false, kind: 'refused', reason: 'store-locked' }) },
      { readBoard: () => board(), bind: () => { throw new Error('/Users/x/bindings'); } },
    ];
    const reasons: unknown[] = [];
    for (const deps of cases) {
      const r = await call(deps, req0);
      expect(r.status).toBe(503);
      expect(r.body['outcome']).toBe('unavailable');
      reasons.push(r.body['reason']);
      noLeakOrPath(r.text);
    }
    expect(reasons).toEqual(['board-unreadable', 'board-unreadable', 'store-locked', 'bind-threw']);
  });

  it('400s an extra key, a non-string, a bad thread and an invalid bind result', async () => {
    const deps = { readBoard: () => board(), bind: () => ({ ok: false as const, kind: 'invalid' as const, reason: 'invalid-repo' }) };
    for (const b of [{ ...req0, extra: 1 }, { ...req0, claimId: 5 }, { ...req0, thread: 'not-a-thread' }, { claimId: 'x' }]) {
      const r = await call({ readBoard: () => board() }, b);
      expect(r.status).toBe(400);
      expect(r.body['outcome']).toBe('invalid-input');
    }
    expect((await call(deps, req0)).status).toBe(400);
  });

  it('405s GET', async () => {
    const r = await call({ readBoard: () => board() }, {}, 'GET');
    expect(r.status).toBe(405);
  });
});
