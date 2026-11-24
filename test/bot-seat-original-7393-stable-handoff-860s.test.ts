import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { registerAgentIdentity, stableAgentId } from '../src/core/agents/bus-identity.js';
import { acquireCoordination, listCoordination } from '../src/core/agents/claim-store.js';
import { applySeatHandoff, listSeats, planSeatHandoff, type SeatOptions } from '../src/core/bots/seats.js';

const homes: string[] = [];
const now = Date.parse('2026-11-18T12:00:00Z');
const iso = new Date(now).toISOString();
const owners = ['helper', 'agent:helper', 'helper-alias', stableAgentId('helper'), 'unrelated'];
const refs = owners.map((_, i) => `pr:o/r#${i + 1}`);

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'seat-7393-')); homes.push(home);
  const root = join(home, '.phantom', 'bots');
  const fleetRoot = join(home, '.ashlr', 'fleet');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'seats.json'), JSON.stringify({ schema: 'phantom-bot-seats.v1', seats: [
    { id: 'helper', kind: 'devin-bot', displayName: 'Helper', participantId: 'helper', capabilities: ['code'], quota: { source: 'none' } },
  ] }));
  expect(registerAgentIdentity({ handle: 'helper', aliases: ['helper-alias'] }, { root: fleetRoot, now: () => now }).status).toBe('created');
  owners.forEach((owner, i) => {
    expect(acquireCoordination({ root: fleetRoot, origin: 'resource', key: refs[i]!, owner, sourceId: `claim-${i}`,
      leaseMs: 3600000, leaseUntil: now + 3600000, now }).status).toBe('acquired');
  });
  await writeFile(join(root, 'seat-state.json'), JSON.stringify({ helper: { state: 'draining', since: iso, exhaustedReset: null } }));
  const ownerNotice = vi.fn(async () => ({ status: 'accepted' }));
  const busPost = vi.fn(async () => ({ status: 'posted' }));
  const opts: SeatOptions = { home, fleetRoot, runs: join(home, 'runs'), now: () => now,
    readQuota: async () => ({ status: 'exhausted', usedPct: 100, asOf: iso, resetAt: null, source: 'test' }), ownerNotice, busPost };
  return { root, fleetRoot, opts, ownerNotice, busPost };
}
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

it('hands off every identity label once while leaving unrelated work live', async () => {
  const { root, fleetRoot, opts, ownerNotice, busPost } = await fixture();
  const expected = refs.slice(0, 4).sort();
  const listed = await listSeats(opts);
  expect(listed.seats[0]!.state).toBe('draining');
  expect(listed.seats[0]!.claims.map(c => c.key).sort()).toEqual(expected);
  const plan = await planSeatHandoff('helper', opts);
  expect(plan.handoffs.map(h => h.work.ref).sort()).toEqual(expected);
  const applied = await applySeatHandoff('helper', opts);
  expect(applied.state).toBe('idle');
  expect(applied.handoffs.map(h => h.work.ref).sort()).toEqual(expected);
  const journal = (await readFile(join(root, 'handoffs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(journal.map(h => h.work.ref).sort()).toEqual(expected);
  expect(listCoordination(fleetRoot, now).claims.filter(c => c.live).map(c => [c.key, c.owner])).toEqual([[refs[4], 'unrelated']]);
  expect((await applySeatHandoff('helper', opts)).handoffs).toEqual([]);
  expect((await readFile(join(root, 'handoffs.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(4);
  expect(ownerNotice).toHaveBeenCalledTimes(4);
  expect(busPost).toHaveBeenCalledTimes(4);
  expect(listCoordination(fleetRoot, now).claims.filter(c => c.live).map(c => [c.key, c.owner])).toEqual([[refs[4], 'unrelated']]);
});

it('plans only the exact owner when the identity registry is unreadable', async () => {
  const { fleetRoot, opts } = await fixture();
  await writeFile(join(fleetRoot, 'agent-identities', 'registry.json'), '{broken', { mode: 0o600 });
  expect((await listSeats(opts)).seats[0]!.claims.map(c => c.key)).toEqual([refs[0]]);
  expect((await planSeatHandoff('helper', opts)).handoffs.map(h => h.work.ref)).toEqual([refs[0]]);
  expect(listCoordination(fleetRoot, now).claims.filter(c => c.live)).toHaveLength(5);
});
