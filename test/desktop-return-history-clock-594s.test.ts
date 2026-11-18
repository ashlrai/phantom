import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { claimFleetWork, postFleetMessage } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import {
  createFleetCoordinationReturnsVerifyApi, VERSE_FLEET_COORDINATION_RETURNS_VERIFY_PATH as PATH,
  type ReturnsVerifyBody,
} from '../src/core/verse/fleet-coordination-returns-verify-api.js';

const T = Date.parse('2026-11-18T15:00:00Z');
const HEAD = 'a'.repeat(40);
let directory: string;
let ledger: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'fake-desktop-return-594s-'));
  ledger = join(directory, 'coordination.jsonl');
  // Only redirect the ledger location: the route uses its real default reader.
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledger);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function durableReceipt() {
  const claimed = claimFleetWork({ repo: 'fake/example', task: 'fake durable return', agent: 'fake-agent' }, { now: T });
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) throw Error('fake claim failed');
  const returned = returnFleetClaim({ id: claimed.value.claim.id, lease: claimed.value.lease,
    agent: 'fake-agent', pr: 1, head: HEAD, ttlMs: 1000 }, { now: T });
  expect(returned).toMatchObject({ ok: true, outcome: 'returned' });
  return claimed.value.claim.id;
}

function setup(ms: number) {
  const clock = { ms };
  const gh = vi.fn(async (_args: string[]) => JSON.stringify({
    state: 'closed', merged: true, merged_at: '2026-11-18T14:00:00Z', head: { sha: HEAD },
  }));
  const route = createFleetCoordinationReturnsVerifyApi({ gh, now: () => new Date(clock.ms) });
  const get = async (): Promise<ReturnsVerifyBody> => {
    let status = 0, body = '';
    const handled = await route({} as VerseApiContext, { url: PATH } as IncomingMessage,
      { writeHead(code: number) { status = code; return this; }, end(text: string) { body = text; } } as unknown as ServerResponse,
      PATH, 'GET');
    expect({ handled, status }).toEqual({ handled: true, status: 200 });
    return JSON.parse(body) as ReturnsVerifyBody;
  };
  return { clock, gh, get };
}

it('excludes expired ordinary RESULT-looking posts from default-read projection and coverage', async () => {
  const claimId = durableReceipt();
  for (const [id, body] of [
    ['return-fake-ordinary', `RESULT VERIFIED fake/example claim fake-ordinary task "fake ordinary": pr #2 head ${HEAD}`],
    ['return-fake-malformed', 'RESULT garbled fake ordinary post'],
  ]) {
    expect(postFleetMessage({ id, body: body!, from: 'fake-agent', to: 'all', ttlMs: 100 }, { now: T }).ok).toBe(true);
  }
  // A still-owned claim expires before observation, so accidental reaping would change bytes.
  expect(claimFleetWork({ repo: 'fake/example', task: 'fake abandoned claim', agent: 'fake-agent', ttlMs: 100 }, { now: T }).ok).toBe(true);
  const before = readFileSync(ledger);
  const s = setup(T + 100);
  const body = await s.get();
  expect(body).toMatchObject({ authority: 'none', asOf: new Date(T + 100).toISOString(),
    returnsState: 'known', complete: true, nonCurrentReceipts: 0,
    coverage: { parsedTotal: 1, omitted: 0, unparsed: 0 }, unparsed: 0 });
  expect(body.checked).toHaveLength(1);
  expect(body.checked[0]).toMatchObject({ claimId, verdict: 'merged-at-head' });
  expect(s.gh).toHaveBeenCalledTimes(1);
  expect(readFileSync(ledger)).toEqual(before);
});

it('retains selected durable history at exact expiry while refreshing currency inside the cache TTL', async () => {
  const claimId = durableReceipt();
  const before = readFileSync(ledger);
  const s = setup(T + 999);
  expect(await s.get()).toMatchObject({ complete: true, nonCurrentReceipts: 0 });
  s.clock.ms = T + 1000;
  const expired = await s.get();
  expect(expired).toMatchObject({ authority: 'none', returnsState: 'known', complete: false, nonCurrentReceipts: 1,
    generatedAt: new Date(T + 999).toISOString(), asOf: new Date(T + 1000).toISOString(),
    coverage: { parsedTotal: 1, omitted: 0, unparsed: 0 } });
  expect(expired.checked).toHaveLength(1);
  expect(expired.checked[0]).toMatchObject({ claimId, verdict: 'merged-at-head' });
  expect(s.gh).toHaveBeenCalledTimes(1);
  expect(readFileSync(ledger)).toEqual(before);
});

it('invalidates a cached success when the real ledger becomes unreadable without leaking reader details', async () => {
  durableReceipt();
  const before = readFileSync(ledger);
  const s = setup(T + 100);
  expect((await s.get()).complete).toBe(true);
  // The reader refuses non-private ledgers, independently of OS read privileges.
  chmodSync(ledger, 0o644);
  const unknown = await s.get();
  expect(unknown).toMatchObject({ authority: 'none', returnsState: 'unknown', complete: false,
    checked: [], coverage: { parsedTotal: null, omitted: null, unparsed: null } });
  expect(JSON.stringify(unknown)).not.toContain(directory);
  expect(s.gh).toHaveBeenCalledTimes(1);
  expect(readFileSync(ledger)).toEqual(before);
});
