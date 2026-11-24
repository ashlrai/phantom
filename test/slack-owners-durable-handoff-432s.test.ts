/** Synthetic ledger qualification for Dot's owner answer; no transports or processes. */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultOwnersReply, ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { claimFleetWork, handoffFleetClaim, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { readSurfaceOwner } from '../src/core/fleet/surface-owner.js';

const dirs: string[] = [];
const A = 'fake-agent-alpha';
const B = 'fake-agent-beta';
const TASK = 'fake private task naming slack-bridge';
const START = Date.parse('2026-11-13T18:13:00.000Z');

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`fixture write failed: ${result.error}`);
  return result.value;
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-owners-432s-'));
  dirs.push(dir);
  const path = join(dir, 'fake-ledger.jsonl');
  let now = START;
  const unrelated = vi.fn((): never => { throw new Error('unexpected unrelated seam'); });
  const log = vi.fn(async () => []);
  const board = vi.fn((options?: { now?: number; reap?: boolean }) =>
    readFleetBoard({ path, now: options?.now, reap: options?.reap }));
  const owners = vi.fn((date: Date) => defaultOwnersReply(date, {
    read: surface => readSurfaceOwner(surface, { board, log, now: () => date.getTime() }),
  }));
  const composer = ownerStatusReply({ owners, bridge: unrelated, brief: unrelated, snapshot: unrelated,
    board: unrelated, runtime: unrelated, recheck: unrelated, recordRecheck: unrelated,
    orders: unrelated, review: unrelated });
  const snapshot = () => ({ entries: readdirSync(dir).sort(), bytes: existsSync(path) ? readFileSync(path).toString('base64') : null });
  const answer = async (forbidden: string[] = []) => {
    const before = snapshot();
    const text = await composer.compose('/fake/runs', new Date(now), 'who owns the bridge');
    expect(snapshot()).toEqual(before);
    expect(text.length).toBeLessThanOrEqual(900);
    expect(text).toContain(`Phantom owners, as of ${new Date(now).toISOString()}`);
    expect(text.endsWith('Claims are advisory; this reply assigns nothing.')).toBe(true);
    for (const value of [path, dir, TASK, 'leaseHash', ...forbidden]) expect(text).not.toContain(value);
    expect(unrelated).not.toHaveBeenCalled();
    return text;
  };
  return { dir, path, answer, board, log, owners, composer, options: () => ({ path, now }), advance: (ms: number) => { now += ms; } };
}

describe('durable ownership in the existing owners answer', () => {
  it('rereads a real claim, handoff and return with one composer', async () => {
    const f = fixture();
    expect(f.composer.ask('who owns the bridge')).toBe(true);
    const claim = must(claimFleetWork({ repo: 'ashlrai/phantom', task: TASK, agent: A }, f.options()));
    expect(await f.answer([claim.lease, claim.claim.id, B])).toContain(`slack-bridge: ${A} (advisory claim`);
    f.advance(1000);
    const handoff = must(handoffFleetClaim({ id: claim.claim.id, agent: A, lease: claim.lease, to: B }, f.options()));
    expect(await f.answer([claim.lease, handoff.lease, claim.claim.id, A])).toContain(`slack-bridge: ${B} (advisory claim`);
    f.advance(1000);
    expect(returnFleetClaim({ id: claim.claim.id, agent: B, lease: handoff.lease, artifact: 'fake-proof.txt' }, f.options()))
      .toMatchObject({ ok: true, outcome: 'returned' });
    expect(await f.answer([claim.lease, handoff.lease, A, B, 'fake-proof.txt']))
      .toContain('slack-bridge: no live owner');
    expect(f.owners).toHaveBeenCalledTimes(3);
    expect(f.board).toHaveBeenCalled();
    expect(f.log).toHaveBeenCalled();
  });

  it('reports missing and corrupt evidence as UNKNOWN, then recovers and expires', async () => {
    const f = fixture();
    expect(await f.answer([A])).toContain('slack-bridge: UNKNOWN (coordination ledger: missing or unreadable)');
    const claim = must(claimFleetWork({ repo: 'ashlrai/phantom', task: TASK, agent: A, ttlMs: 60_000 }, f.options()));
    const valid = readFileSync(f.path);
    expect(await f.answer([claim.lease])).toContain(`slack-bridge: ${A} (advisory claim`);
    writeFileSync(f.path, 'fake corrupt ledger\n');
    expect(await f.answer([A, claim.lease])).toContain('slack-bridge: UNKNOWN (coordination ledger: missing or unreadable)');
    writeFileSync(f.path, valid);
    f.advance(1000);
    expect(await f.answer([claim.lease])).toContain(`slack-bridge: ${A} (advisory claim`);
    f.advance(60_000);
    expect(await f.answer([A, claim.lease])).toContain('slack-bridge: no live owner');
  });

  it('does not attribute another repository’s same-surface claim to Phantom', async () => {
    const f = fixture();
    const claim = must(claimFleetWork({ repo: 'example/unrelated', task: TASK, agent: A }, f.options()));
    expect(await f.answer([A, claim.lease, claim.claim.id])).toContain('slack-bridge: no live owner');
  });
});
