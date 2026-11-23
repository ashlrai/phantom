import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applySeatHandoff, listSeats, nextSeatState, planSeatHandoff, planSeatHandoffs, seatMayClaim, seatParticipants, sendSeatMessage, transitionSeatState, type QuotaEvidence, type SeatOptions, type SeatState } from '../src/core/bots/seats.js';
import { createDevinBotAdapter } from '../src/core/bots/devin-bot-adapter.js';
import { participantSchema } from '../src/core/agents/bus-v2-schema.js';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { acquireCoordination, listCoordination, releaseCoordinationBySource } from '../src/core/agents/claim-store.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { busBodyJobIds } from '../src/core/agents/bus-unified.js';
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
  await writeFile(join(root, 'seats.json'), JSON.stringify({ schema: 'phantom-bot-seats.v1', seats: Array.isArray(value) ? value : [value] }));
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
it('plans every seat handoff in one read with per-seat eligibility', async () => {
  const reviewer = { id: 'reviewer', kind: 'local', displayName: 'Reviewer', participantId: 'reviewer', capabilities: ['review'], quota: { source: 'none' } };
  const idler = { id: 'idler', kind: 'local', displayName: 'Idler', participantId: 'idler', capabilities: ['review'], quota: { source: 'none' } };
  const o = await fixture([seat(), reviewer, idler]);
  const fleetRoot = join(o.home, '.ashlr', 'fleet');
  acquireCoordination({ root: fleetRoot, origin: 'resource', key: 'pr:o/r#20', owner: 'helper', sourceId: 'fleet-claim', leaseMs: 3600000, leaseUntil: now + 3600000, now });
  acquireCoordination({ root: fleetRoot, origin: 'resource', key: 'pr:o/r#21', owner: 'reviewer', sourceId: 'active-claim', leaseMs: 3600000, leaseUntil: now + 3600000, now });
  await writeFile(join(o.root, 'seat-state.json'), JSON.stringify({
    helper: { state: 'draining', since: iso(), exhaustedReset: null },
    reviewer: { state: 'active', since: iso(), exhaustedReset: null },
    idler: { state: 'idle', since: iso(), exhaustedReset: null },
  }));
  // idler is eligible only through prior handoff history: apply retries its unfinished notices.
  await writeFile(join(o.root, 'handoffs.jsonl'), JSON.stringify({ schema: 'phantom-bot-handoff.v1', handoffId: 'old-handoff', seatId: 'idler', work: { kind: 'bus-claim', ref: 'pr:o/r#9' }, done: 'unknown', left: 'unknown', branch: null, pr: null, createdAt: iso() }) + '\n');
  const opts: SeatOptions = { ...o, readQuota: async () => unknown };
  const stateBefore = await readFile(join(o.root, 'seat-state.json'), 'utf8');
  const plan = await planSeatHandoffs(opts);
  expect(plan.schema).toBe('phantom-bot-handoffs-plan.v1');
  expect(plan.apply).toBe(false);
  expect(plan.seats.map(s => s.seatId)).toEqual(['helper', 'reviewer', 'idler']);
  const [h, r, i] = plan.seats;
  expect(h).toMatchObject({ seatId: 'helper', state: 'draining', eligible: true });
  expect(h!.handoffs.map(x => x.work.ref)).toEqual(['pr:o/r#20']);
  // An active seat keeps its work: not a handoff candidate, so no records leak.
  expect(r).toMatchObject({ seatId: 'reviewer', state: 'active', eligible: false, handoffs: [] });
  expect(i).toMatchObject({ seatId: 'idler', state: 'idle', eligible: true, handoffs: [] });
  // Fleet ids are the same deterministic ids the single-seat plan and apply journal.
  const single = await planSeatHandoff('helper', opts);
  expect(h!.handoffs[0]!.handoffId).toBe(single.handoffs[0]!.handoffId);
  // Read-only: no state or journal writes.
  expect(await readFile(join(o.root, 'seat-state.json'), 'utf8')).toBe(stateBefore);
  expect((await readFile(join(o.root, 'handoffs.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
});
it('CLI handoffs plans the whole roster read-only and reports an empty roster', async () => {
  const o = await fixture();
  const out: string[] = [], emit = (text: string) => out.push(text);
  expect(await runBotsCli(['handoffs', '--json'], emit, o.home)).toBe(0);
  expect(JSON.parse(out.pop()!)).toEqual({ schema: 'phantom-bot-handoffs-plan.v1', apply: false,
    seats: [{ seatId: 'helper', participantId: 'helper', state: 'active', eligible: false, handoffs: [] }] });
  expect(await readdir(o.root)).toEqual(['seats.json']);
  await rm(join(o.root, 'seats.json'));
  expect(await runBotsCli(['handoffs', '--json'], emit, o.home)).toBe(0);
  expect(JSON.parse(out.pop()!)).toEqual({ schema: 'phantom-bot-handoffs-plan.v1', apply: false, seats: [] });
});
it('fences source releases to the lease generation and still releases the current holder', async () => {
  const o = await fixture();
  const root = join(o.home, '.ashlr', 'fleet');
  const sourceId = 'same-source';
  const oldLeaseUntil = now + 10_000;
  expect(acquireCoordination({ root, origin: 'resource', key: 'pr:o/r#12', owner: 'old-holder',
    sourceId, leaseMs: 10_000, leaseUntil: oldLeaseUntil, now }).status).toBe('acquired');
  const successorLeaseUntil = now + 20_001;
  expect(acquireCoordination({ root, origin: 'resource', key: 'pr:o/r#12', owner: 'successor',
    sourceId, leaseMs: 10_000, leaseUntil: successorLeaseUntil, now: now + 10_001 }).status).toBe('acquired');

  expect(releaseCoordinationBySource({ root, origin: 'resource', sourceId, owner: 'old-holder',
    leaseUntil: oldLeaseUntil, now: now + 10_002 }).status).toBe('stale');
  expect(listCoordination(root, now + 10_002).claims).toContainEqual(expect.objectContaining({
    sourceId, owner: 'successor', leaseUntil: successorLeaseUntil, live: true,
  }));

  expect(releaseCoordinationBySource({ root, origin: 'resource', sourceId, owner: 'successor',
    leaseUntil: successorLeaseUntil, now: now + 10_002 }).status).toBe('released');
  expect(listCoordination(root, now + 10_002).claims).not.toContainEqual(expect.objectContaining({ sourceId }));
});
it('keeps a successor lease when a seat handoff releases its stale snapshot', async () => {
  const o = await fixture({ ...seat(), nodeId: 'helper-node' });
  const root = join(o.home, '.ashlr', 'fleet');
  const sourceId = 'handoff-race';
  const oldLeaseUntil = now + 10_000;
  acquireCoordination({ root, origin: 'resource', key: 'pr:o/r#13', owner: 'helper',
    sourceId, leaseMs: 10_000, leaseUntil: oldLeaseUntil, now });
  let clock = now, replaced = false;
  const state = emptyState();
  const store: NodesStore = { transaction: fn => {
    const result = fn(state);
    if (!replaced) {
      replaced = true;
      clock = now + 10_001;
      acquireCoordination({ root, origin: 'resource', key: 'pr:o/r#13', owner: 'successor',
        sourceId, leaseMs: 10_000, leaseUntil: now + 20_001, now: clock });
    }
    return result;
  } };
  const result = await applySeatHandoff('helper', {
    ...o, now: () => clock, nodesStore: store, readQuota: async () => exhausted,
    ownerNotice: async () => undefined, busPost: async () => undefined,
  });

  expect(result.handoffs).toHaveLength(1);
  expect(listCoordination(root, clock).claims).toContainEqual(expect.objectContaining({
    sourceId, owner: 'successor', leaseUntil: now + 20_001, live: true,
  }));
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

it('posts a real bus note to leaders for each handed-off record by default', async () => {
  const o = await fixture();
  const fleetRoot = join(o.home, '.ashlr', 'fleet');
  acquireCoordination({ root: fleetRoot, origin: 'resource', key: 'pr:o/r#6', owner: 'helper', sourceId: 'bus-note-claim', leaseMs: 3600000, leaseUntil: Date.now() + 3600000, now: Date.now() });
  await writeFile(join(o.root, 'seat-state.json'), JSON.stringify({ helper: { state: 'draining', since: iso(), exhaustedReset: null } }));
  const ownerNotice = vi.fn(async () => ({ status: 'accepted' }));
  const opts: SeatOptions = { ...o, readQuota: async () => exhausted, ownerNotice };
  const result = await applySeatHandoff('helper', opts);
  expect(result.handoffs).toHaveLength(1);
  expect(result.handoffs[0]!.notifications).toEqual({ bus: 'posted', owner: 'accepted' });
  const page = listBusInboxAfter(0, 100, { root: fleetRoot });
  expect(page.status).toBe('ok');
  const rows = page.status === 'ok' ? page.messages : [];
  expect(rows).toHaveLength(1);
  const envelope = rows[0]!.envelope;
  expect(envelope.id).toBe(result.handoffs[0]!.handoffId);
  expect(envelope.from).toBe('helper');
  expect(envelope.to).toBe('leaders');
  expect(envelope.priority).toBe('P2');
  expect(envelope.channel).toBe('bus');
  expect(envelope.origin_bridge).toBe('bot-seats');
  expect(envelope.body).toEqual({ kind: 'note', text: 'Seat helper handed off bus-claim pr:o/r#6. Done: unknown; left: unknown.' });
  // A replayed apply neither re-appends nor re-notifies.
  expect((await applySeatHandoff('helper', opts)).handoffs).toEqual([]);
  const again = listBusInboxAfter(0, 100, { root: fleetRoot });
  expect(again.status === 'ok' ? again.messages : []).toHaveLength(1);
});
it('cites a node-job handoff notice under its job thread and leaves claim keys uncited', async () => {
  const o = await fixture({ ...seat(), nodeId: 'helper-node' });
  const fleetRoot = join(o.home, '.ashlr', 'fleet');
  const state = emptyState();
  const store: NodesStore = { transaction: fn => fn(state) };
  const router = new DriveNodes(store, { now: o.now });
  const node = router.join('helper-node')!;
  const leader = router.heartbeat(node)!.leader!;
  router.enqueue('node-job-7'); router.claim(leader, node, 'node-job-7');
  router.enqueue('x'.repeat(130)); router.claim(leader, node, 'x'.repeat(130));
  acquireCoordination({ root: fleetRoot, origin: 'resource', key: 'pr:o/r#9', owner: 'helper', sourceId: 'bus-cite-claim', leaseMs: 3600000, leaseUntil: now + 3600000, now });
  await writeFile(join(o.root, 'seat-state.json'), JSON.stringify({ helper: { state: 'draining', since: iso(), exhaustedReset: null } }));
  const opts: SeatOptions = { ...o, nodesStore: store, readQuota: async () => exhausted,
    ownerNotice: async () => ({ status: 'accepted' }) };
  const result = await applySeatHandoff('helper', opts);
  expect(result.handoffs.map(h => `${h.work.kind}:${h.work.ref}`).sort())
    .toEqual([`bus-claim:pr:o/r#9`, 'node-job:node-job-7', `node-job:${'x'.repeat(130)}`].sort());
  const page = listBusInboxAfter(0, 100, { root: fleetRoot });
  expect(page.status).toBe('ok');
  const rows = page.status === 'ok' ? page.messages : [];
  expect(rows).toHaveLength(3);
  const bodyOf = (fragment: string) => {
    const row = rows.find(r => typeof r.envelope.body === 'object' && r.envelope.body !== null &&
      'text' in r.envelope.body && String((r.envelope.body as { text: unknown }).text).includes(fragment));
    expect(row, `notice mentioning ${fragment}`).toBeDefined();
    return row!.envelope.body as Record<string, unknown>;
  };
  // A node-job ref is the job id every `--job` bus read already matches, so the
  // notice carries the same `job:<id>` thread citation work traffic uses.
  const cited = bodyOf('node-job node-job-7');
  expect(cited['thread']).toBe('job:node-job-7');
  expect(busBodyJobIds(cited)).toEqual(['node-job-7']);
  // A ref too long to form a valid bus label cites nothing rather than guessing.
  expect(bodyOf(`node-job ${'x'.repeat(130)}`)).not.toHaveProperty('thread');
  // A bus-claim ref is a coordination claim key, never a job citation.
  expect(bodyOf('bus-claim pr:o/r#9')).not.toHaveProperty('thread');
});
it('routes seat-to-seat messages through the seat fleet root and clock', async () => {
  const reviewer = { id: 'reviewer', kind: 'local', displayName: 'Reviewer', participantId: 'reviewer', capabilities: ['review'], quota: { source: 'none' } };
  const o = await fixture([seat(), reviewer]);
  const fleetRoot = join(o.home, '.ashlr', 'fleet');
  for (const handle of ['helper', 'reviewer']) {
    expect(registerAgentIdentity({ handle }, { root: fleetRoot, now: o.now }).status).toBe('created');
  }
  const result = await sendSeatMessage({ from: 'helper', to: 'reviewer', text: 'please review' }, o);
  expect(result).toMatchObject({ status: 'posted', to: 'agent:reviewer' });
  const page = listBusInboxAfter(0, 100, { root: fleetRoot, now: o.now });
  expect(page.status).toBe('ok');
  const rows = page.status === 'ok' ? page.messages : [];
  expect(rows).toHaveLength(1);
  expect(rows[0]!.envelope.from).toBe('agent:helper');
  expect(rows[0]!.envelope.to).toBe('agent:reviewer');
  expect(rows[0]!.receivedAt).toBe(now);
});
it('CLI message routes seat DMs by seat id and owner notices through the configured thread', async () => {
  const reviewer = { id: 'reviewer', kind: 'local', displayName: 'Reviewer', participantId: 'seat-reviewer', capabilities: ['review'], quota: { source: 'none' } };
  const o = await fixture([seat(), reviewer]);
  const fleetRoot = join(o.home, '.ashlr', 'fleet');
  for (const handle of ['helper', 'seat-reviewer']) {
    expect(registerAgentIdentity({ handle }, { root: fleetRoot, now: o.now }).status).toBe('created');
  }
  const out: string[] = [], emit = (text: string) => out.push(text);
  // --to accepts the seat id; the DM still addresses the participantId.
  expect(await runBotsCli(['message', '--from', 'helper', '--to', 'reviewer', '--text', 'please review', '--json'], emit, o.home)).toBe(0);
  expect(JSON.parse(out.pop()!)).toMatchObject({ status: 'posted', to: 'agent:seat-reviewer' });
  const page = listBusInboxAfter(0, 100, { root: fleetRoot, now: o.now });
  const rows = page.status === 'ok' ? page.messages : [];
  expect(rows).toHaveLength(1);
  expect(rows[0]!.envelope.from).toBe('agent:helper');
  expect(rows[0]!.envelope.to).toBe('agent:seat-reviewer');

  expect(await runBotsCli(['message', '--from', 'helper', '--to', 'owner', '--text', 'seat check-in', '--json'], emit, o.home)).toBe(0);
  expect(JSON.parse(out.pop()!)).toMatchObject({ status: 'accepted' });
  const thread = readOwnerThread({ runsDir: join(o.home, '.ashlr-runs'), settings: emptyOwnerSettings() });
  expect(thread.messages.map(m => m.text)).toContain('seat check-in');
  // The owner notice mirrors onto the same fleet root the seat DMs use.
  const mirrored = listBusInboxAfter(0, 100, { root: fleetRoot, now: o.now });
  const mirrorRows = mirrored.status === 'ok' ? mirrored.messages : [];
  expect(mirrorRows.some(r => r.envelope.id.startsWith('ot-seat-message:'))).toBe(true);

  expect(await runBotsCli(['message', '--from', 'helper', '--to', 'reviewer'], emit, o.home)).toBe(1);
  expect(JSON.parse(out.pop()!)).toMatchObject({ ok: false });
  expect(await runBotsCli(['message', '--from', 'helper', '--to', 'nobody', '--text', 'hi', '--json'], emit, o.home)).toBe(1);
  expect(JSON.parse(out.pop()!)).toMatchObject({ ok: false, error: 'Unknown seat.' });
});
it('counts claims held under any label of the seat identity as open work', async () => {
  const o = await fixture();
  const fleetRoot = join(o.home, '.ashlr', 'fleet');
  expect(registerAgentIdentity({ handle: 'helper', aliases: ['helper-alias'] }, { root: fleetRoot, now: o.now }).status).toBe('created');
  for (const [key, owner, sourceId] of [
    ['pr:o/r#8', 'helper-alias', 'alias-claim'],
    ['pr:o/r#9', 'agent:helper', 'address-claim'],
    ['pr:o/r#10', 'unrelated', 'other-claim'],
  ] as const) {
    expect(acquireCoordination({ root: fleetRoot, origin: 'resource', key, owner, sourceId,
      leaseMs: 3600000, leaseUntil: now + 3600000, now }).status).toBe('acquired');
  }
  await writeFile(join(o.root, 'seat-state.json'), JSON.stringify({ helper: { state: 'draining', since: iso(), exhaustedReset: null } }));
  const opts: SeatOptions = { ...o, readQuota: async () => exhausted,
    ownerNotice: async () => ({ status: 'accepted' }), busPost: async () => ({ status: 'posted' }) };
  const listed = await listSeats(opts);
  expect(listed.seats[0]!.state).toBe('draining');
  expect(listed.seats[0]!.claims.map(c => c.owner).sort()).toEqual(['agent:helper', 'helper-alias']);
  const plan = await planSeatHandoff('helper', opts);
  expect(plan.handoffs.map(h => h.work.ref).sort()).toEqual(['pr:o/r#8', 'pr:o/r#9']);
  const applied = await applySeatHandoff('helper', opts);
  expect(applied.handoffs).toHaveLength(2);
  expect(applied.state).toBe('idle');
  expect(listCoordination(fleetRoot, now).claims.filter(c => c.live).map(c => c.owner)).toEqual(['unrelated']);
});
it('keeps exact-label seat claims when the identity registry is unreadable', async () => {
  const o = await fixture();
  const fleetRoot = join(o.home, '.ashlr', 'fleet');
  registerAgentIdentity({ handle: 'helper', aliases: ['helper-alias'] }, { root: fleetRoot, now: o.now });
  for (const [key, owner, sourceId] of [
    ['pr:o/r#11', 'helper', 'exact-claim'],
    ['pr:o/r#12', 'helper-alias', 'alias-claim'],
  ] as const) {
    acquireCoordination({ root: fleetRoot, origin: 'resource', key, owner, sourceId,
      leaseMs: 3600000, leaseUntil: now + 3600000, now });
  }
  await writeFile(join(fleetRoot, 'agent-identities', 'registry.json'), '{broken', { mode: 0o600 });
  await writeFile(join(o.root, 'seat-state.json'), JSON.stringify({ helper: { state: 'draining', since: iso(), exhaustedReset: null } }));
  const listed = await listSeats({ ...o, readQuota: async () => exhausted });
  expect(listed.seats[0]!.claims.map(c => c.owner)).toEqual(['helper']);
  expect(listed.seats[0]!.state).toBe('draining');
});
it('reports an unavailable bus store honestly instead of claiming a posted note', async () => {
  const o = await fixture();
  const fleetRoot = join(o.home, '.ashlr', 'fleet');
  acquireCoordination({ root: fleetRoot, origin: 'resource', key: 'pr:o/r#7', owner: 'helper', sourceId: 'bus-down-claim', leaseMs: 3600000, leaseUntil: Date.now() + 3600000, now: Date.now() });
  await writeFile(join(fleetRoot, 'bus-inbox'), 'not a directory');
  await writeFile(join(o.root, 'seat-state.json'), JSON.stringify({ helper: { state: 'draining', since: iso(), exhaustedReset: null } }));
  const result = await applySeatHandoff('helper', { ...o, readQuota: async () => exhausted,
    ownerNotice: async () => ({ status: 'accepted' }) });
  expect(result.handoffs[0]!.notifications).toEqual({ bus: 'unavailable', owner: 'accepted' });
});
