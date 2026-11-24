import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createFleetCoordinationReturnsVerifyApi, VERSE_FLEET_COORDINATION_RETURNS_VERIFY_PATH as PATH } from '../src/core/verse/fleet-coordination-returns-verify-api.js';

const T = Date.parse('2026-11-14T18:00:00Z');
const FULL_HEAD = 'a'.repeat(40);
function setup() {
  let ms = T, unreadable = false;
  const receipt = (claim = 'fake', head = 'aaaaaaa', repo = 'fake/example') => ({
    id: `return-${claim}`, from: 'fake', to: 'fleet', at: T - 1, expiresAt: T + 1000,
    body: `RESULT VERIFIED ${repo} claim ${claim} task "fake": pr #1 head ${head}`,
  });
  const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0, proposals: [], claims: [], messages: [receipt()] };
  const gh = vi.fn(async (_args: string[]) => JSON.stringify({ state: 'closed', merged: true, merged_at: '2026-11-14T17:00:00Z', head: { sha: FULL_HEAD } }));
  const read = vi.fn(() => { if (unreadable) throw Error('private-reader-error'); return board; });
  const route = createFleetCoordinationReturnsVerifyApi({ read, gh, now: () => new Date(ms) });
  const get = async () => {
    let body = '';
    await route({} as VerseApiContext, { url: PATH } as IncomingMessage,
      { writeHead() { return this; }, end(s: string) { body = s; } } as unknown as ServerResponse, PATH, 'GET');
    return JSON.parse(body);
  };
  return { get, gh, read, board, receipt, time: (n: number) => { ms = n; }, fail: () => { unreadable = true; } };
}

it('refreshes temporal currency at exact expiry and retains GitHub timestamps until TTL or rollback', async () => {
  const s = setup();
  expect((await s.get()).complete).toBe(true);
  s.time(T + 1000);
  expect(await s.get()).toMatchObject({ complete: false, nonCurrentReceipts: 1, generatedAt: new Date(T).toISOString(), asOf: new Date(T + 1000).toISOString() });
  expect(s.gh).toHaveBeenCalledTimes(1);
  s.time(T + 60_000); await s.get();
  s.time(T + 59_999); await s.get();
  expect(s.gh).toHaveBeenCalledTimes(3);
  expect(s.read).toHaveBeenCalledTimes(4);
});

it('invalidates changed provenance, conflicting heads, coverage, removal and unreadable ledgers', async () => {
  const s = setup(); await s.get();
  s.board.messages = [s.receipt('other', 'bbbbbbb', 'fake/other')];
  expect((await s.get()).checked[0]).toMatchObject({ claimId: 'other', repo: 'fake/other', head: 'bbbbbbb', verdict: 'merged-other-head' });
  s.board.messages.push(s.receipt());
  expect(await s.get()).toMatchObject({ complete: false, coverage: { parsedTotal: 2 }, checked: expect.arrayContaining([expect.objectContaining({ claimId: 'fake' })]) });
  s.board.messages.push({ ...s.receipt(), id: 'return-malformed', body: 'RESULT garbled' });
  expect((await s.get()).coverage.unparsed).toBe(1);
  s.fail();
  const failed = await s.get();
  expect(failed).toMatchObject({ returnsState: 'unknown', complete: false, checked: [], coverage: { parsedTotal: null } });
  expect(JSON.stringify(failed)).not.toContain('private-reader-error');
  const removed = setup(); await removed.get(); removed.board.messages = [];
  expect(await removed.get()).toMatchObject({ checked: [], coverage: { parsedTotal: 0 } });
});

it('coalesces matching inputs while isolating a changed ledger during an outstanding sweep', async () => {
  const s = setup();
  let release!: (value: string) => void;
  s.gh.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
  const old = s.get(), same = s.get();
  expect(s.gh).toHaveBeenCalledTimes(1);
  s.board.messages = [s.receipt('new', 'bbbbbbb')];
  const changed = await s.get();
  expect(changed).toMatchObject({ complete: false, checked: [expect.objectContaining({ claimId: 'new', verdict: 'merged-other-head' })] });
  release(JSON.stringify({ merged: true, head: { sha: FULL_HEAD } }));
  const [a, b] = await Promise.all([old, same]);
  expect(a).toEqual(b);
  expect(a).toMatchObject({ complete: true, checked: [expect.objectContaining({ claimId: 'fake' })] });
  expect((await s.get()).checked).toEqual(changed.checked);
  expect(s.gh).toHaveBeenCalledTimes(2);
});
