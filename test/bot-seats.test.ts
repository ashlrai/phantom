import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applySeatHandoff, listSeats, nextSeatState, planSeatHandoff, seatMayClaim, seatParticipants, sendSeatMessage, transitionSeatState, type QuotaEvidence, type SeatOptions, type SeatState } from '../src/core/bots/seats.js';
import { createDevinBotAdapter } from '../src/core/bots/devin-bot-adapter.js';
import { participantSchema } from '../src/core/agents/bus-v2-schema.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { DriveNodes, type NodesStore } from '../src/core/drive/nodes/index.js';
import { emptyState } from '../src/core/drive/nodes/state.js';
import { runBotsCli } from '../src/cli/bots.js';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';
import { readOwnerThread } from '../src/core/comms/owner-thread.js';

const homes: string[] = [];
const now = Date.parse('2026-11-18T12:00:00Z');
const iso = (n = now) => new Date(n).toISOString();
const measured: QuotaEvidence = { status: 'measured', usedPct: 30, asOf: iso(), resetAt: null, source: 'test' };
const exhausted: QuotaEvidence = { ...measured, status: 'exhausted', usedPct: 100 };
const unknown: QuotaEvidence = { status: 'unknown', reason: 'missing-key', asOf: null };
const seat = () => ({ id: 'helper', kind: 'devin-bot', displayName: 'Helper', participantId: 'helper', capabilities: ['code'], secretHandle: 'phm_devin_api_key', quota: { source: 'none' } });
async function fixture(value: unknown = seat()) {
  const home = await mkdtemp(join(tmpdir(), 'bot-seats-')); homes.push(home);
  const root = join(home, '.phantom', 'bots');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'seats.json'), JSON.stringify({ schema: 'phantom-bot-seats.v1', seats: [value] }));
  return { home, root, now: () => now, runs: join(home, 'runs') };
}
afterEach(async () => { await Promise.all(homes.splice(0).map(h => rm(h, { recursive: true, force: true }))); });
it('enforces all lifecycle edges and fresh reset evidence', () => {
  const active: SeatState = { state: 'active', since: iso(now - 10), exhaustedReset: null };
  expect(() => transitionSeatState(active, 'idle', iso())).toThrow();
  expect(() => transitionSeatState(active, 'active', iso())).toThrow();
  const draining = nextSeatState(active, { quota: { ...exhausted, resetAt: iso(now + 100) }, openWork: 1, now: iso() });
  expect(draining.state).toBe('draining');
  expect(nextSeatState(draining, { quota: unknown, openWork: 0, now: iso() })).toEqual(draining);
  const idle = nextSeatState(draining, { quota: exhausted, openWork: 0, now: iso() });
  expect(idle.state).toBe('idle');
  expect(nextSeatState(idle, { quota: measured, openWork: 0, now: iso(now + 200) })).toEqual(idle);
  const fresh = { ...measured, asOf: iso(now + 200), resetAt: iso(now + 1000) };
  expect(nextSeatState(idle, { quota: fresh, openWork: 0, now: iso(now + 50) })).toEqual(idle);
  expect(nextSeatState(idle, { quota: fresh, openWork: 0, now: iso(now + 200) }).state).toBe('active');
  expect(nextSeatState({ ...idle, exhaustedReset: null }, { quota: fresh, openWork: 0, now: iso(now + 200) }).state).toBe('active');
});
it('keeps unknown honest, validates participants, rejects secret values and unknown senders', async () => {
  const o = await fixture();
  const output = await listSeats(o);
  expect(output.schema).toBe('phantom-bot-seats.v1');
  expect(participantSchema.safeParse(output.seats[0].participant).success).toBe(true);
  expect(output.seats[0].quota).toEqual({ status: 'unknown', reason: 'no-quota-source', asOf: null });
  expect(JSON.stringify(output)).toContain('phm_devin_api_key');
  expect(JSON.stringify(output)).not.toContain('usedPct');
  expect(await seatMayClaim('helper', o)).toBe(false);
  expect(await seatMayClaim('helper', { ...o, readQuota: async () => measured })).toBe(true);
  for (const p of await seatParticipants(o)) expect(participantSchema.safeParse(p).success).toBe(true);
  await expect(sendSeatMessage({ from: 'missing', to: 'owner', text: 'hello' }, o)).rejects.toThrow('Unknown seat');
  const secret = `sk-${'A'.repeat(32)}`;
  await expect(sendSeatMessage({ from: 'helper', to: 'owner', text: secret }, o)).rejects.toThrow();
  await writeFile(join(o.root, 'seats.json'), JSON.stringify({ schema: 'phantom-bot-seats.v1', seats: [{ ...seat(), displayName: secret }] }));
  await expect(listSeats(o)).rejects.toThrow('Secret-shaped');
});
it('reads stale and null lane quota as unknown, and Devin never spends', async () => {
  expect(await createDevinBotAdapter().message('hello')).toMatchObject({ status: 'refused', refused: 'usage-evidence-missing' });
  const o = await fixture({ ...seat(), quota: { source: 'lane-budget', lane: 'devin' } });
  await mkdir(join(o.runs, 'queue'), { recursive: true });
  for (const entry of [{ weekly_used_pct: null, as_of: iso() }, { weekly_used_pct: 20, as_of: iso(now - 7200000) }, { weekly_used_pct: 20, as_of: iso(), reset_at: iso(now - 1) }]) {
    await writeFile(join(o.runs, 'queue', 'budget-overrides.json'), JSON.stringify({ devin: entry }));
    expect((await listSeats(o)).seats[0]).toMatchObject({ acceptsNewWork: false, quota: { status: 'unknown', reason: 'stale-or-missing' } });
  }
  for (const evidence of [unknown, exhausted, measured]) {
    const adapter = createDevinBotAdapter({ secretHandle: 'phm_devin_api_key', readUsage: async () => evidence });
    expect((await adapter.status()).status).toBe('unknown');
    const result = await adapter.message('hello');
    expect(result).toMatchObject(evidence === measured ? { status: 'advisory' } : { status: 'refused', refused: evidence === unknown ? 'usage-evidence-missing' : 'quota-exhausted' });
  }
});
it('plans read-only and hands each live bus claim and fenced node job off once', async () => {
  const o = await fixture({ ...seat(), nodeId: 'helper-node' });
  const state = emptyState();
  const store: NodesStore = { transaction: fn => fn(state) };
  const router = new DriveNodes(store, { now: o.now });
  const node = router.join('helper-node')!;
  const leader = router.heartbeat(node)!.leader!;
  router.enqueue('job'); router.claim(leader, node, 'job');
  expect(acquireCoordination({ root: join(o.home, '.ashlr', 'fleet'), origin: 'resource', key: 'pr:o/r#3', owner: 'helper', sourceId: 'claim-one', leaseMs: 10000, leaseUntil: now + 10000, now }).status).toBe('acquired');
  const ownerNotice = vi.fn(async () => undefined), busPost = vi.fn(async () => undefined);
  const opts: SeatOptions = { ...o, nodesStore: store, readQuota: async () => exhausted, ownerNotice, busPost };
  expect((await planSeatHandoff('helper', opts)).handoffs).toHaveLength(2);
  expect(await readdir(o.root)).toEqual(['seats.json']);
  const first = await applySeatHandoff('helper', opts);
  expect(first.handoffs).toHaveLength(2);
  expect(first.handoffs.find(h => h.work.kind === 'bus-claim')?.pr).toBe('o/r#3');
  expect((await applySeatHandoff('helper', opts)).handoffs).toEqual([]);
  expect((await readFile(join(o.root, 'handoffs.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
  expect(ownerNotice).toHaveBeenCalledTimes(2); expect(busPost).toHaveBeenCalledTimes(2);
  expect(state.jobs[0].state).toBe('pending'); expect(state.jobs[0].declined).toEqual([node.session]);
  expect((await stat(join(o.root, 'seat-state.json'))).mode & 0o777).toBe(0o600);
  expect((await stat(join(o.root, 'handoffs.jsonl'))).mode & 0o777).toBe(0o600);
});
it('CLI emits empty roster and dry-run/apply JSON; refuses active or unknown seats', async () => {
  const o = await fixture();
  const out: string[] = [], emit = (text: string) => out.push(text);
  expect(await runBotsCli(['seats', '--json'], emit, o.home)).toBe(0);
  expect(JSON.parse(out.pop()!).schema).toBe('phantom-bot-seats.v1');
  expect(await runBotsCli(['handoff', '--seat', 'helper', '--json'], emit, o.home)).toBe(1);
  expect(await readdir(o.root)).toEqual(['seats.json']);
  await writeFile(join(o.root, 'seat-state.json'), JSON.stringify({ helper: { state: 'draining', since: iso(), exhaustedReset: null } }));
  expect(await runBotsCli(['handoff', '--seat', 'helper', '--json'], emit, o.home)).toBe(0);
  expect(JSON.parse(out.pop()!)).toMatchObject({ apply: false, handoffs: [] });
  expect(await runBotsCli(['handoff', '--seat', 'helper', '--apply', '--json'], emit, o.home)).toBe(0);
  expect(JSON.parse(out.pop()!)).toMatchObject({ apply: true });
  await expect(planSeatHandoff('missing', o)).rejects.toThrow('Unknown seat');
  await rm(join(o.root, 'seats.json'));
  expect(await listSeats(o)).toEqual({ schema: 'phantom-bot-seats.v1', seats: [] });
});
it('recovers a crash after the durable journal append without duplicate release or notices', async () => {
  const o = await fixture({ ...seat(), nodeId: 'helper-node' });
  const state = emptyState();
  const store: NodesStore = { transaction: fn => fn(state) };
  const router = new DriveNodes(store, { now: o.now });
  const node = router.join('helper-node')!;
  const leader = router.heartbeat(node)!.leader!;
  router.enqueue('crash-job'); router.claim(leader, node, 'crash-job');
  const ownerNotice = vi.fn(async () => ({ status: 'accepted' }));
  const busPost = vi.fn(async () => ({ status: 'posted' }));
  const release = vi.spyOn(router, 'release');
  let crash = true;
  const opts: SeatOptions = { ...o, nodesStore: store, readQuota: async () => exhausted, ownerNotice, busPost,
    releaseNode: claim => { if (crash) { crash = false; throw new Error('simulated crash'); } return router.release(claim, true); } };
  await expect(applySeatHandoff('helper', opts)).rejects.toThrow('simulated crash');
  expect((await readFile(join(o.root, 'handoffs.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  expect(state.jobs[0].state).toBe('running');
  expect(ownerNotice).not.toHaveBeenCalled();
  expect((await applySeatHandoff('helper', opts)).handoffs[0].notifications).toEqual({ bus: 'posted', owner: 'accepted' });
  expect((await applySeatHandoff('helper', opts)).handoffs).toEqual([]);
  expect(release).toHaveBeenCalledTimes(1);
  expect(ownerNotice).toHaveBeenCalledTimes(1); expect(busPost).toHaveBeenCalledTimes(1);
  expect((await readFile(join(o.root, 'handoffs.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
});
it('reports notification failures without undoing or throwing after release', async () => {
  const o = await fixture();
  acquireCoordination({ root: join(o.home, '.ashlr', 'fleet'), origin: 'resource', key: 'pr:o/r#4', owner: 'helper', sourceId: 'notify-claim', leaseMs: 10000, leaseUntil: now + 10000, now });
  const opts: SeatOptions = { ...o, readQuota: async () => exhausted,
    busPost: async () => { throw new Error(`sk-${'A'.repeat(32)}`); },
    ownerOptions: { runsDir: o.runs, settings: emptyOwnerSettings(), halted: true } };
  const result = await applySeatHandoff('helper', opts);
  expect(result.handoffs[0].notifications).toEqual({ bus: 'failed', owner: 'halted' });
  expect(JSON.stringify(result)).not.toContain('sk-');
  expect((await applySeatHandoff('helper', opts)).handoffs).toEqual([]);
});
it('CLI apply posts a real owner-thread notice with default options', async () => {
  const o = await fixture();
  acquireCoordination({ root: join(o.home, '.ashlr', 'fleet'), origin: 'resource', key: 'pr:o/r#5', owner: 'helper', sourceId: 'cli-claim', leaseMs: 3600000, leaseUntil: Date.now() + 3600000, now: Date.now() });
  await writeFile(join(o.root, 'seat-state.json'), JSON.stringify({ helper: { state: 'draining', since: iso(), exhaustedReset: null } }));
  const out: string[] = [];
  expect(await runBotsCli(['handoff', '--seat', 'helper', '--apply', '--json'], text => out.push(text), o.home)).toBe(0);
  expect(JSON.parse(out[0]).handoffs[0].notifications.owner).toBe('accepted');
  expect(readOwnerThread({ runsDir: join(o.home, '.ashlr-runs'), settings: emptyOwnerSettings() }).messages).toHaveLength(1);
});
it('seat reads and dry-run handoff do not initialize a missing node store on a fresh home', async () => {
  const o = await fixture({ ...seat(), nodeId: 'helper-node' });
  const before = await readdir(o.home, { recursive: true });
  const opts = { ...o, readQuota: async () => exhausted };
  expect((await planSeatHandoff('helper', opts)).handoffs).toEqual([]);
  expect(await readdir(o.home, { recursive: true })).toEqual(before);
  await listSeats(opts);
  expect((await readdir(o.home, { recursive: true })).sort()).toEqual([...before, '.phantom/bots/seat-state.json'].sort());
});
