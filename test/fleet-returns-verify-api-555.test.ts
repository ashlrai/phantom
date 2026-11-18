/** GET /api/verse/fleet/coordination-claims/returns/verify: the desktop's
 * GitHub second reader for VERIFIED pr receipts. Fake ledger and fake gh only. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import { createFleetCoordinationClaimsApi } from '../src/core/verse/fleet-coordination-claims-api.js';
import {
  createFleetCoordinationReturnsVerifyApi, VERSE_FLEET_COORDINATION_RETURNS_VERIFY_PATH as PATH,
} from '../src/core/verse/fleet-coordination-returns-verify-api.js';
import { parseVerify } from '../src/web-ui/routes/verse/fleet-board/returns-verify-model.js';

const T = Date.parse('2026-11-14T18:00:00.000Z');
const HEADS: Record<number, string> = { 11: 'a'.repeat(40), 12: 'b'.repeat(40) };
const VERIFY_PATH_LITERAL = '/api/verse/fleet/coordination-claims/returns/verify';

function board(): FleetBoard {
  return {
    schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0, proposals: [], claims: [],
    messages: [11, 12].map(pr => ({
      id: `return-claim-fake-${pr}`, from: 'agent-fake', to: 'fleet', at: T - 500, expiresAt: T + 3_600_000,
      body: `RESULT VERIFIED ashlrai/example claim claim-fake-${pr} task "fake task": pr #${pr} head ${HEADS[pr]}`,
    })),
  };
}

/** Fake gh: every PR merged at its claimed head unless overridden by number. */
function fakeGh(over: Record<number, Record<string, unknown>> = {}) {
  return vi.fn(async (args: string[]) => {
    const pr = Number(args.at(-1)!.split('/').pop());
    return JSON.stringify(over[pr] ?? { state: 'closed', merged: true, merged_at: '2026-11-14T17:00:00Z', head: { sha: HEADS[pr] } });
  });
}

async function call(api: ApiModule, method = 'GET', url = PATH) {
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { text = body; },
  } as unknown as ServerResponse;
  const path = url.split('?')[0]!;
  const handled = await api({} as VerseApiContext, { url } as IncomingMessage, res, path, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

function api(gh: ReturnType<typeof fakeGh>, clock = { ms: T }, read: () => FleetBoard = board) {
  return createFleetCoordinationReturnsVerifyApi({ read, gh, now: () => new Date(clock.ms) });
}

describe('coordination returns verify route', () => {
  it('is complete when GitHub reports every receipt merged at its claimed head', async () => {
    const gh = fakeGh();
    const r = await call(api(gh));
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body).toMatchObject({
      v: 1, authority: 'none', generatedAt: new Date(T).toISOString(), asOf: new Date(T).toISOString(),
      returnsState: 'known', coverage: { parsedTotal: 2, omitted: 0, unparsed: 0 }, unparsed: 0,
      skipped: 0, truncated: false, complete: true,
    });
    expect(r.body.checked.map((c: { verdict: string }) => c.verdict)).toEqual(['merged-at-head', 'merged-at-head']);
    expect(gh).toHaveBeenCalledTimes(2);
    expect(parseVerify(r.body)?.complete).toBe(true);
  });

  it('is incomplete when one PR is still open', async () => {
    const r = await call(api(fakeGh({ 12: { state: 'open', merged: false, head: { sha: HEADS[12] } } })));
    expect(r.body.complete).toBe(false);
    expect(r.body.checked.find((c: { pr: number }) => c.pr === 12).verdict).toBe('open');
  });

  it('is incomplete for an expired receipt, an unparsed return, or an unreadable ledger', async () => {
    const expired = await call(api(fakeGh(), { ms: T + 4_000_000 }));
    expect(expired.body).toMatchObject({ complete: false, nonCurrentReceipts: 2 });
    const unparsedBoard = () => {
      const b = board();
      b.messages.push({ id: 'return-claim-fake-13', from: 'agent-fake', to: 'fleet', at: T - 400, expiresAt: T + 1000, body: 'RESULT garbled' });
      return b;
    };
    expect((await call(api(fakeGh(), { ms: T }, unparsedBoard))).body).toMatchObject({ complete: false, unparsed: 1 });
    const gh = fakeGh();
    const unreadable = await call(api(gh, { ms: T }, () => { throw new Error('secret-path /fake/leak'); }));
    expect(unreadable.body).toMatchObject({ returnsState: 'unknown', complete: false, checked: [] });
    expect(JSON.stringify(unreadable.body)).not.toContain('leak');
    expect(gh).not.toHaveBeenCalled();
  });

  it('reports unknown/read-failed without leaking gh error text', async () => {
    const gh = vi.fn(async () => { throw new Error('gh api: fake-token-leak HTTP 502'); });
    const r = await call(api(gh));
    expect(r.status).toBe(200);
    expect(r.body.complete).toBe(false);
    expect(r.body.checked).toHaveLength(2);
    for (const row of r.body.checked) expect(row).toMatchObject({ verdict: 'unknown', reason: 'read-failed', observedHead: null });
    expect(JSON.stringify(r.body)).not.toMatch(/leak|502|gh api/);
  });

  it('answers 400 to any query, 405 to non-GET, and declines other paths', async () => {
    const gh = fakeGh();
    const route = api(gh);
    expect(await call(route, 'GET', `${PATH}?limit=50`)).toMatchObject({ handled: true, status: 400 });
    expect(await call(route, 'GET', `${PATH}?`)).toMatchObject({ handled: true, status: 400 });
    expect(await call(route, 'POST')).toMatchObject({ handled: true, status: 405 });
    expect((await call(route, 'GET', `${PATH}/extra`)).handled).toBe(false);
    expect(gh).not.toHaveBeenCalled();
  });

  it('shares one GitHub sweep between concurrent requests', async () => {
    const gh = fakeGh();
    const route = api(gh);
    const [a, b] = await Promise.all([call(route), call(route)]);
    expect(gh).toHaveBeenCalledTimes(2);
    expect(a.body).toEqual(b.body);
    expect(a.body.complete).toBe(true);
  });

  it('reuses GitHub observations for 60 s with a fresh ledger asOf', async () => {
    const gh = fakeGh();
    const clock = { ms: T };
    const route = api(gh, clock);
    const first = await call(route);
    clock.ms = T + 59_000;
    const second = await call(route);
    expect(gh).toHaveBeenCalledTimes(2);
    expect(second.body).toEqual({ ...first.body, asOf: new Date(clock.ms).toISOString() });
    clock.ms = T + 60_000;
    expect((await call(route)).body.generatedAt).toBe(new Date(T + 60_000).toISOString());
    expect(gh).toHaveBeenCalledTimes(4);
  });

  it('is dispatched by the claims module ahead of the /returns match', async () => {
    expect(PATH).toBe(VERIFY_PATH_LITERAL);
    const gh = fakeGh();
    const returns = vi.fn(async () => true);
    const claims = createFleetCoordinationClaimsApi({ read: board, returns, returnsVerify: api(gh) });
    expect((await call(claims, 'GET', VERIFY_PATH_LITERAL)).body).toMatchObject({ complete: true, authority: 'none' });
    expect(returns).not.toHaveBeenCalled();
    // The default seam resolves the same path lazily; POST proves it without touching gh or the ledger.
    expect(await call(createFleetCoordinationClaimsApi({ read: board }), 'POST')).toMatchObject({ handled: true, status: 405 });
  });
});
