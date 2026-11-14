/** RQ-PHX-BOARDINBOXFAILCLAIMS325S — when the work-board inbox scan fails,
 * the result must still carry the claims table state from the one inspection
 * listWorkBoard already performs: 'available' (validated, possibly empty),
 * 'missing' or 'unavailable' stay distinct from each other and from a
 * validated empty table during an inbox outage. Before this change the
 * unavailable-inbox result dropped `claims` entirely, so a degraded bridge
 * lost the only ownership evidence it had. Exercises listWorkBoard and
 * cmdFleetWorkBoard against real durable stores in a private tmp root, plus
 * one mocked throw to cover the caught-read-error path. Fixtures are plainly
 * fake; labels grant no authority and no fencing token may appear in output.
 * Reads must leave fixture bytes unchanged. */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { readBusInboxEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { cmdFleetWorkBoard } from '../src/cli/fleet-work-board.js';

const real = vi.hoisted(() => ({
  readBusInboxEvidence: undefined as unknown as typeof import('../src/core/comms/work-item-bus-evidence.js').readBusInboxEvidence,
}));
vi.mock('../src/core/comms/work-item-bus-evidence.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/comms/work-item-bus-evidence.js')>();
  real.readBusInboxEvidence = mod.readBusInboxEvidence;
  return { ...mod, readBusInboxEvidence: vi.fn(mod.readBusInboxEvidence) };
});

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
const claimsDir = () => join(root, 'bus-work-claims');
const claimsFile = () => join(claimsDir(), 'claims.json');
const inboxDir = () => join(root, 'bus-inbox');
const inboxFile = () => join(inboxDir(), 'messages.json');
const writeClaims = (content: string) => {
  mkdirSync(claimsDir(), { mode: 0o700 });
  writeFileSync(claimsFile(), content, { mode: 0o600 });
};
/** A settled-then-corrupt inbox: the file exists but cannot be parsed, so the
 * bounded scan reports unavailable rather than an invented empty board. */
const breakInbox = () => {
  mkdirSync(inboxDir(), { mode: 0o700, recursive: true });
  writeFileSync(inboxFile(), 'invalid', { mode: 0o600 });
};
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
  root = mkdtempSync(join(tmpdir(), 'work-board-inbox-fail-claims-325s-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(readBusInboxEvidence).mockReset().mockImplementation(real.readBusInboxEvidence);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('listWorkBoard claims source on inbox failure', { timeout: 60_000 }, () => {
  it.each(['available', 'missing', 'unavailable'] as const)(
    'a malformed inbox with a %s claims table keeps the claims source', state => {
      if (state !== 'missing') writeClaims(state === 'available' ? '[]' : 'invalid');
      breakInbox();
      const board = listWorkBoard({ root, now });
      expect(board).toEqual({ items: [], inbox: 'unavailable', truncated: false, claims: state });
    });

  it('a thrown inbox read still carries the claims source', () => {
    writeClaims('[]');
    vi.mocked(readBusInboxEvidence).mockImplementationOnce(() => {
      throw new Error('fake inbox read failure');
    });
    const board = listWorkBoard({ root, now });
    expect(board).toEqual({ items: [], inbox: 'unavailable', truncated: false, claims: 'available' });
  });

  it('a healthy inbox regression: items list and claims still report', () => {
    post('healthy-request');
    const board = listWorkBoard({ root, now });
    expect(board.inbox).toBe('ok');
    expect(board.claims).toBe('missing');
    expect(board.items).toHaveLength(1);
    expect(board.items[0]).toMatchObject({ id: 'healthy-request', owner: null });
  });
});

describe('cmdFleetWorkBoard claims source on inbox failure', { timeout: 60_000 }, () => {
  it('missing claims: JSON and footer carry claims=missing beside inbox=unavailable', async () => {
    breakInbox();
    const before = snapshot();
    const parsed = await runJson();
    expect(parsed).toMatchObject({ items: [], inbox: 'unavailable', claims: 'missing' });
    const lines = await runText();
    expect(lines.at(-1)).toBe(
      `items=0 truncated=no inbox=unavailable as-of=${new Date(now).toISOString()} claims=missing`);
    expect(snapshot()).toEqual(before);
  });

  it('available-empty claims: JSON carries available and the legacy footer stays bare', async () => {
    writeClaims('[]');
    breakInbox();
    const before = snapshot();
    const parsed = await runJson();
    expect(parsed).toMatchObject({ items: [], inbox: 'unavailable', claims: 'available' });
    const lines = await runText();
    expect(lines.at(-1)).toBe(
      `items=0 truncated=no inbox=unavailable as-of=${new Date(now).toISOString()}`);
    expect(snapshot()).toEqual(before);
  });

  it('corrupt claims: unavailable is visible in JSON and the footer', async () => {
    writeClaims('invalid');
    breakInbox();
    const parsed = await runJson();
    expect(parsed).toMatchObject({ items: [], inbox: 'unavailable', claims: 'unavailable' });
    const lines = await runText();
    expect(lines.at(-1)).toMatch(/^items=0 truncated=no inbox=unavailable as-of=\S+ claims=unavailable$/);
    for (const line of lines) expect(line).not.toMatch(/[a-f0-9]{64}/);
  });

  it('a bound claim beside an unreadable inbox leaks no fencing token', async () => {
    post('claimed-request');
    const claim = acquire('claimed-request', 'fake-worker');
    expect(claim.status).toBe('acquired');
    breakInbox();
    const parsed = await runJson();
    expect(parsed).toMatchObject({ items: [], inbox: 'unavailable', claims: 'available' });
    expect(JSON.stringify(parsed)).not.toContain(claim.token!);
    expect(JSON.stringify(parsed)).not.toMatch(/[a-f0-9]{64}/);
    const lines = await runText();
    expect(lines.join('\n')).not.toContain(claim.token!);
    expect(lines.join('\n')).not.toMatch(/[a-f0-9]{64}/);
  });
});
