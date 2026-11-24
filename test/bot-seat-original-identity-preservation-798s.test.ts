import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { registerAgentIdentity, stableAgentId } from '../src/core/agents/bus-identity.js';
import { acquireCoordination, listCoordination } from '../src/core/agents/claim-store.js';
import { applySeatHandoff, listSeats, planSeatHandoff, type SeatOptions } from '../src/core/bots/seats.js';

const homes: string[] = [];
const now = Date.parse('2026-11-18T12:00:00Z');
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'seat-original-')); homes.push(home);
  const root = join(home, '.phantom', 'bots');
  const fleetRoot = join(home, '.ashlr', 'fleet');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'seats.json'), JSON.stringify({ schema: 'phantom-bot-seats.v1', seats: [{ id: 'helper', kind: 'devin-bot', displayName: 'Helper', participantId: 'helper', capabilities: ['code'], quota: { source: 'none' } }] }));
  expect(registerAgentIdentity({ handle: 'helper', aliases: ['helper-bot'] }, { root: fleetRoot, now: () => now }).status).toBe('created');
  const opts: SeatOptions = { home, root, runs: join(home, 'runs'), now: () => now,
    readQuota: async () => ({ status: 'exhausted', usedPct: 100, asOf: new Date(now).toISOString(), resetAt: null, source: 'test' }),
    ownerNotice: async () => ({ status: 'accepted' }), busPost: async () => ({ status: 'posted' }) };
  const own = (key: string, owner: string, sourceId: string) => acquireCoordination({ root: fleetRoot, origin: 'resource', key, owner, sourceId, leaseMs: 10000, leaseUntil: now + 10000, now }).status;
  return { fleetRoot, opts, own };
}

it('counts and hands off the original handle, alias and stable ID claims only', async () => {
  const { fleetRoot, opts, own } = await fixture();
  expect(own('pr:o/r#20', 'helper', 'label-one')).toBe('acquired');
  expect(own('pr:o/r#21', 'helper-bot', 'label-two')).toBe('acquired');
  expect(own('pr:o/r#22', stableAgentId('helper'), 'label-three')).toBe('acquired');
  expect(own('pr:o/r#23', 'other-agent', 'label-four')).toBe('acquired');
  expect((await listSeats(opts)).seats[0]!.claims.map(c => c.owner).sort()).toEqual(['helper', 'helper-bot', stableAgentId('helper')].sort());
  expect((await applySeatHandoff('helper', opts)).handoffs.map(h => h.work.ref).sort()).toEqual(['pr:o/r#20', 'pr:o/r#21', 'pr:o/r#22']);
  expect(listCoordination(fleetRoot, now).claims.filter(c => c.live).map(c => c.owner)).toEqual(['other-agent']);
});

it('plans only the exact label when the identity registry is unreadable', async () => {
  const { fleetRoot, opts, own } = await fixture();
  expect(own('pr:o/r#30', 'helper', 'exact-label')).toBe('acquired');
  expect(own('pr:o/r#31', 'helper-bot', 'alias-label')).toBe('acquired');
  await writeFile(join(fleetRoot, 'agent-identities', 'registry.json'), '{not json');
  expect((await listSeats(opts)).seats[0]!.claims.map(c => c.owner)).toEqual(['helper']);
  expect((await planSeatHandoff('helper', opts)).handoffs.map(h => h.work.ref)).toEqual(['pr:o/r#30']);
});
