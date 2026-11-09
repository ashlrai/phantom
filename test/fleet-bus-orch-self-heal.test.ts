import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Concurrent appends replace messages.json and touch bus-inbox/ while a reader
// holds its stable snapshot. Forcing that verdict deterministically lets the
// tests prove the race is retried and surfaced as 'retryable', never 'unavailable'.
const churn = vi.hoisted(() => ({ remaining: 0, reason: 'changed-during-read' as string }));
vi.mock('../src/core/util/stable-file-read.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/util/stable-file-read.js')>();
  return {
    ...actual,
    readStableRegularFile: ((file, options) => {
      if (String(file).endsWith(join('bus-inbox', 'messages.json')) && churn.remaining > 0) {
        churn.remaining--;
        return { ok: false, reason: churn.reason };
      }
      return actual.readStableRegularFile(file, options);
    }) as typeof actual.readStableRegularFile,
  };
});

const { appendBusInbox, listBusInboxAfter } = await import('../src/core/fleet/bus-inbox.js');
const { CLAIM_MAX_ROWS, mutateBusWorkClaim } = await import('../src/core/fleet/bus-work-claims.js');
const { claimNextBusWork } = await import('../src/core/fleet/bus-next-claim.js');
const { waitClaimBusWork } = await import('../src/core/fleet/bus-wait-claim.js');

let root: string, now: number;
const claimsFile = () => join(root, 'bus-work-claims', 'claims.json');
function post(id: string, ttl = 10_000) {
  expect(appendBusInbox({ id, from: 'fake', to: 'shared', priority: 'P1', ttl, body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bus-self-heal-'));
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  churn.remaining = 0; churn.reason = 'changed-during-read';
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('bus inbox reads under concurrent appends', () => {
  it('re-reads through transient churn instead of failing the page', () => {
    post('message');
    churn.remaining = 2;
    const page = listBusInboxAfter(0, 10, { root, now: () => now });
    expect(page.status).toBe('ok');
    expect(churn.remaining).toBe(0);
  });
  it('reports sustained churn as retryable, and other read failures as unavailable', () => {
    post('message');
    churn.remaining = 100;
    expect(listBusInboxAfter(0, 10, { root, now: () => now }).status).toBe('retryable');
    churn.remaining = 1; churn.reason = 'unsafe-file';
    expect(listBusInboxAfter(0, 10, { root, now: () => now }).status).toBe('unavailable');
  });
  it('lets claim and renewal callers retry churn rather than treat it as loss', () => {
    post('message');
    const acquired = mutateBusWorkClaim({ action: 'acquire', id: 'message', owner: 'w', leaseMs: 1000, root });
    expect(acquired.status).toBe('acquired');
    churn.remaining = 100;
    expect(mutateBusWorkClaim({ action: 'renew', id: 'message', token: acquired.token, root }).status).toBe('retryable');
    expect(claimNextBusWork({ to: 'shared', owner: 'w', leaseMs: 1000, root }).status).toBe('retryable');
    churn.remaining = 0;
    expect(mutateBusWorkClaim({ action: 'renew', id: 'message', token: acquired.token, root }).status).toBe('renewed');
  });
  it('waits out churn and still claims the work', async () => {
    post('message');
    churn.remaining = 4; // first scan exhausts its re-reads; the next poll succeeds
    vi.mocked(Date.now).mockRestore();
    const result = await waitClaimBusWork({ to: 'shared', owner: 'w', leaseMs: 1000, waitMs: 5_000, root });
    expect(result.status).toBe('acquired');
  });
});

describe('bus work claims table self-heals', () => {
  it('drops rows whose receipt TTL has lapsed, so a full table of dead rows admits new work', () => {
    const receivedAt = now - 100_000;
    const dead = Array.from({ length: CLAIM_MAX_ROWS }, (_, i) => ({
      id: `old-${i}`, cursor: i + 1, receivedAt, ttl: 1000, token: i.toString(16).padStart(64, '0'),
      owner: 'w', leaseMs: 1000, leaseUntil: receivedAt + 1000, completedAt: receivedAt + 1,
    }));
    mkdirSync(join(root, 'bus-work-claims'), { mode: 0o700 });
    post('fresh');
    writeFileSync(claimsFile(), JSON.stringify(dead), { mode: 0o600 });
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'fresh', owner: 'w', leaseMs: 1000, root }).status).toBe('acquired');
    const rows = JSON.parse(readFileSync(claimsFile(), 'utf8')) as { id: string }[];
    expect(rows.map(r => r.id)).toEqual(['fresh']);
  });
  it('keeps completed rows while their receipt is live, so work is not re-claimed', () => {
    post('done', 10_000);
    post('other', 10_000);
    const first = mutateBusWorkClaim({ action: 'acquire', id: 'done', owner: 'w', leaseMs: 1000, root });
    expect(mutateBusWorkClaim({ action: 'complete', id: 'done', token: first.token, root }).status).toBe('completed');
    now += 5_000;
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'other', owner: 'w', leaseMs: 1000, root }).status).toBe('acquired');
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'done', owner: 'x', leaseMs: 1000, root }).status).toBe('completed');
    now += 6_000;
    post('later', 10_000);
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'later', owner: 'w', leaseMs: 1000, root }).status).toBe('acquired');
    const ids = (JSON.parse(readFileSync(claimsFile(), 'utf8')) as { id: string }[]).map(r => r.id);
    expect(ids).toEqual(['later']);
  });
});
