/** RQ-PHX-BOARDCLAIMREADPROOF324S — the work board must let agents distinguish
 * an empty claims table ('available' with zero rows) from a missing table
 * ('missing') and an unreadable one ('unavailable'), in both the JSON board
 * and the text footer, instead of silently reporting owner-less items. On
 * master the inspection source was discarded, so an inaccessible claims
 * store looked like verified absence of ownership. Exercises listWorkBoard
 * and cmdFleetWorkBoard against real durable stores in a private tmp root.
 * Fixtures are plainly fake; labels grant no authority and no fencing token
 * may appear in any output. */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { cmdFleetWorkBoard } from '../src/cli/fleet-work-board.js';

let root: string, now: number;
const TTL = 10_000_000;
const request = (id: string): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
  body: { kind: 'work' },
});
const post = (id: string) => {
  expect(appendBusInbox(request(id), { root, now: () => now }).status).toBe('posted');
};
const acquire = (id: string, owner: string) =>
  mutateBusWorkClaim({ action: 'acquire', id, owner, leaseMs: 600_000, root });
const claimsFile = () => join(root, 'bus-work-claims', 'claims.json');
/** Every file under root as path -> content, so a read-only command is proven
 * to create or change nothing. */
const snapshot = (): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { out[relative(root, path) + '/'] = 'dir'; walk(path); }
      else out[relative(root, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return out;
};
const runText = async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetWorkBoard(['--root', root])).toBe(0);
  const lines = log.mock.calls.map(call => String(call[0]));
  log.mockRestore();
  return lines;
};
const runJson = async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetWorkBoard(['--root', root, '--json'])).toBe(0);
  const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
  log.mockRestore();
  return parsed;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-board-claims-324s-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('listWorkBoard claims availability', { timeout: 60_000 }, () => {
  it('a validated empty claims table reports available, not missing', () => {
    post('empty-table-request');
    const claim = acquire('empty-table-request', 'fake-worker');
    expect(claim.status).toBe('acquired');
    expect(mutateBusWorkClaim({ action: 'release', id: 'empty-table-request',
      token: claim.token!, root }).status).toBe('released');
    expect(readFileSync(claimsFile(), 'utf8')).toBe('[]');

    const board = listWorkBoard({ root, now });
    expect(board.inbox).toBe('ok');
    expect(board.claims).toBe('available');
    expect(board.items).toHaveLength(1);
    expect(board.items[0]).toMatchObject({ owner: null, claimReceipt: null, state: 'RECEIVED' });
  });

  it('a missing claims table reports missing while items still list', () => {
    post('no-table-request');
    const board = listWorkBoard({ root, now });
    expect(board.inbox).toBe('ok');
    expect(board.claims).toBe('missing');
    expect(board.items[0]).toMatchObject({ id: 'no-table-request', owner: null });
  });

  it('a malformed claims table reports unavailable, never verified absence', () => {
    post('broken-table-request');
    const claim = acquire('broken-table-request', 'fake-worker');
    expect(claim.status).toBe('acquired');
    writeFileSync(claimsFile(), 'invalid');

    const board = listWorkBoard({ root, now });
    expect(board.inbox).toBe('ok');
    expect(board.claims).toBe('unavailable');
    // Owners stay unknown: no claim evidence is fabricated from a bad table.
    expect(board.items[0]).toMatchObject({ owner: null, claimReceipt: null });
    expect(JSON.stringify(board)).not.toContain(claim.token!);
    expect(JSON.stringify(board)).not.toMatch(/[a-f0-9]{64}/);
  });

  it('a bound claim still reports available with receipt-bound ownership', () => {
    post('owned-request');
    const claim = acquire('owned-request', 'fake-worker');
    expect(claim.status).toBe('acquired');

    const board = listWorkBoard({ root, now });
    expect(board.claims).toBe('available');
    expect(board.items[0]).toMatchObject({
      owner: 'fake-worker', state: 'RUNNING',
      claimReceipt: `bus-claim:owned-request:1:${now}` });
    expect(JSON.stringify(board)).not.toContain(claim.token!);
  });

  it('an unavailable inbox keeps the legacy result shape with no claims key', () => {
    // A valid claims table beside an unreadable inbox: the board has no
    // items and the failure projection is byte-identical to before — claims
    // availability is only asserted on boards that list items.
    mkdirSync(join(root, 'bus-work-claims'), { mode: 0o700 });
    writeFileSync(claimsFile(), '[]', { mode: 0o600 });
    mkdirSync(join(root, 'bus-inbox'), { mode: 0o700 });
    writeFileSync(join(root, 'bus-inbox', 'messages.json'), 'invalid', { mode: 0o600 });
    const board = listWorkBoard({ root, now });
    expect(board).toEqual({ items: [], inbox: 'unavailable', truncated: false });
    expect(board.claims).toBeUndefined();
  });
});

describe('cmdFleetWorkBoard claims availability', { timeout: 60_000 }, () => {
  it('JSON carries claims and the text footer flags only non-available states', async () => {
    post('cli-request');
    const claim = acquire('cli-request', 'fake-worker');
    expect(claim.status).toBe('acquired');
    expect(mutateBusWorkClaim({ action: 'release', id: 'cli-request',
      token: claim.token!, root }).status).toBe('released');

    // Valid empty table: claims=available in JSON; the legacy footer is
    // unchanged so existing consumers see no new token.
    const before = snapshot();
    const parsed = await runJson();
    expect(parsed).toMatchObject({ inbox: 'ok', claims: 'available' });
    expect(parsed.items[0]).toMatchObject({ owner: null, claimReceipt: null });
    const lines = await runText();
    expect(lines.at(-1)).toBe(`items=1 truncated=no inbox=ok as-of=${new Date(now).toISOString()}`);
    expect(lines.at(-1)).not.toContain('claims=');
    for (const line of lines) expect(line).not.toMatch(/[a-f0-9]{64}/);
    expect(snapshot()).toEqual(before);
  });

  it('missing and unreadable tables are visibly distinct in text and JSON', async () => {
    post('flag-request');
    // Missing table.
    expect((await runJson()).claims).toBe('missing');
    let lines = await runText();
    expect(lines.at(-1)).toContain('claims=missing');
    expect(lines.at(-1)).toMatch(/^items=1 truncated=no inbox=ok as-of=\S+ claims=missing$/);

    // Unreadable table: same null owners, but the footer says unavailable —
    // never a positive claim that no owner exists.
    const claim = acquire('flag-request', 'fake-worker');
    expect(claim.status).toBe('acquired');
    writeFileSync(claimsFile(), 'invalid');
    const parsed = await runJson();
    expect(parsed).toMatchObject({ inbox: 'ok', claims: 'unavailable' });
    expect(parsed.items[0]).toMatchObject({ owner: null, claimReceipt: null });
    lines = await runText();
    expect(lines.at(-1)).toContain('claims=unavailable');
    expect(String(lines.at(-1))).not.toContain(claim.token!);
    expect(lines.join('\n')).not.toMatch(/[a-f0-9]{64}/);
  });
});
