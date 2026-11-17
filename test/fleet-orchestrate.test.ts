import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orchestrateFleet, type OrchestrationOptions } from '../src/core/fleet/orchestrate.js';
import { cmdFleetOrchestrate } from '../src/cli/fleet-orchestrate.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import type { FleetSnapshot } from '../src/core/fleet/chief-of-staff.js';
import { assignSpecialist, loadSpecialistRoster, saveSpecialistRoster, SPECIALIST_ROSTER_SCHEMA } from '../src/core/fleet/roster.js';
import { appendSpecialistOutcome } from '../src/core/fleet/specialist-memory.js';
import { readPeerInbox } from '../src/core/agentnet/peer-bus.js';
import { readOwnerThread } from '../src/core/comms/owner-thread.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';
import { localWriteGate } from '../src/core/agents/send-gate.js';
vi.mock('../src/core/agents/send-gate.js', () => ({ localWriteGate: vi.fn(() => null) }));

let root: string, directory: string, now: number, options: OrchestrationOptions, approved: boolean, call: SlackCall;
const session = (n: number) => ({ lane: 'codex', sessionId: `session-${n}`, token: `synthetic-peer-session-${n}-${'a'.repeat(32)}` });
const at = (offset = 0) => new Date(now + offset).toISOString();
const job = (id: string): FleetSnapshot['jobs'][number] => ({ id, lane: 'codex', status: 'ready', priority: 50,
  queuedAt: '2026-11-15T11:59:00.000Z', startedAt: null });
const snapshot = (): FleetSnapshot => ({ at: at(), jobs: [job('RQ-A')], outcomes: [], lanes: [{ lane: 'codex',
  held: false, target: 2, ceiling: 2, queueDepth: 1, running: 0, errorRate: 0, emptyRate: 0, openPrConflicts: 0,
  quota: { remainingFraction: 1, resetAt: at(3600_000) } }] });
const events = () => Array.from({ length: 20 }, (_, i) => [
  { event: 'launch', job: `OLD-${i}`, lane: 'codex', ts: at(-3600_000), model: 'fixture', tier: 'work' },
  { event: 'finish', job: `OLD-${i}`, lane: 'codex', ts: at(-1800_000), empty: true, hasPr: false, exit_code: 0 },
]).flat();
const posts = () => vi.mocked(call).mock.calls.filter(([method]) => method === 'chat.postMessage');
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fleet-orchestrate-')); directory = join(root, 'queue/specialists');
  now = Date.parse('2026-11-15T12:00:00.000Z'); approved = true;
  vi.mocked(localWriteGate).mockReturnValue(null);
  const peers = ['leader', 'parser'].map((callsign, n) => ({ callsign, lane: 'codex', sessionId: session(n).sessionId,
    sessionHash: createHash('sha256').update(JSON.stringify(['codex', session(n).sessionId, session(n).token])).digest('hex'),
    expiresAt: now + 86400_000, teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh' }));
  const bindings = join(root, 'bindings.json');
  await writeFile(bindings, JSON.stringify({ version: 1, peers }), { mode: 0o600 });
  call = vi.fn(async (method, args = {}) => {
    if (method === 'auth.test') return { team_id: 'TTEAM', user_id: 'UAGENT0', bot_id: 'BAGENT0' };
    if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true,
      is_shared: false, is_ext_shared: false, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
    if (method === 'conversations.members') return { members: ['UAGENT0', 'UAGENT1'] };
    if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
    if (method === 'chat.postMessage') return { channel: args.channel, ts: '1794000000.000001' };
    throw new Error('Unexpected transport method');
  });
  const policy = (): SlackDeliveryPolicy => ({ config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: 'UAGENT0',
    ownBotId: 'BAGENT0', botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] },
    confirmedByMason: approved, teamIdentities: peers.map(p => ({ channel: 'slack', id: p.userId })) });
  options = { directory, now: () => now, session: session(0),
    peers: { bindings, busRoot: root, runsDir: root, now: () => now, call, readPolicy: policy },
    owner: { runsDir: root, busRoot: root, now: () => now,
      settings: { owners: {}, secretHandles: {}, confirmed: false, team: [], imessageBridge: 'off' } } };
  const roster = assignSpecialist({ schema: SPECIALIST_ROSTER_SCHEMA, specialists: [] }, 'parser', 'parser correctness');
  roster.specialists[0].allowedLanes = ['codex'];
  await saveSpecialistRoster(roster, directory);
  await appendSpecialistOutcome(roster.specialists[0], { job: 'OLD', outcome: 'note',
    summary: 'Preserve quoted tabs in the parser.', at: at(-3600_000) }, directory);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('bounded company orchestration', () => {
  it('previews named assignments with memory and weekly advice without writes or transport', async () => {
    await writeFile(join(directory, 'memory/parser.md'), `${'Earlier decision.\n'.repeat(1000)}Preserve quoted tabs in the parser.`);
    const before = await readFile(join(directory, 'roster.json'), 'utf8');
    const result = await orchestrateFleet({ snapshot: snapshot(), events: events() }, options);
    expect(result).toMatchObject({ dryRun: true, execute: { launched: 0 }, report: { status: 'preview' } });
    expect(result.assignments[0].request?.text).toContain('Preserve quoted tabs');
    expect(result.assignments[0].request!.text.length).toBeLessThanOrEqual(12_000);
    expect(result.assignments[0].request?.text).toContain('Outcome advice (suggestOnly)');
    expect(result.plan.feedback.suggestions).toMatchObject({ suggestOnly: true, laneTargetDeltas: [{ lane: 'codex', delta: -1 }] });
    expect(result.plan.laneTargets[0].current).toBe(2);
    expect(call).not.toHaveBeenCalled();
    expect(await readFile(join(directory, 'roster.json'), 'utf8')).toBe(before);
    await expect(readFile(join(directory, 'orchestration.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('closes two real fixture cycles through authenticated peers, outcome measurement and owner thread', async () => {
    const input = { snapshot: snapshot(), events: events(), apply: true };
    const first = await orchestrateFleet(input, options);
    expect(first).toMatchObject({ ok: true, report: { status: 'accepted' }, assignments: [{ delivery: { status: 'posted', slack: 'sent' } }] });
    const inbox = readPeerInbox(session(1), 0, options.peers);
    expect(inbox.status === 'ok' && inbox.messages).toHaveLength(1);
    expect(JSON.stringify(inbox)).toContain('Preserve quoted tabs');
    expect((await loadSpecialistRoster(directory)).specialists[0].currentJob).toBe('RQ-A');
    await orchestrateFleet(input, options);
    expect(posts()).toHaveLength(1);
    expect(readOwnerThread(options.owner!).messages).toHaveLength(1);
    now += 120_000;
    const next = snapshot(); next.jobs.push(job('RQ-B'));
    next.outcomes = [{ job: 'RQ-A', lane: 'codex', phase: 'finish', result: 'success', at: at(-1000) }];
    const ledger = [...events(), { event: 'launch', job: 'RQ-A', lane: 'codex', ts: at(-119_000) },
      { event: 'finish', job: 'RQ-A', lane: 'codex', ts: at(-1000), empty: false, hasPr: false, exit_code: 0 }];
    const second = await orchestrateFleet({ snapshot: next, events: ledger, top: 1, apply: true }, options);
    expect(second.assignments.map(a => [a.job, a.status])).toEqual([['RQ-B', 'posted']]);
    expect(second.metrics.totals).toMatchObject({ jobs: 21, finished: 21 });
    expect(second.plan.feedback.weekly).toContain('21');
    expect(second.plan.feedback.suggestions.suggestOnly).toBe(true);
    expect((await loadSpecialistRoster(directory)).specialists[0].currentJob).toBe('RQ-B');
    expect(posts()).toHaveLength(2);
    expect(readOwnerThread(options.owner!).messages.at(-1)?.text).toContain('Leader: ready');
    expect(second.execute).toEqual({ status: 'existing-dispatch', launched: 0 });
  });
  it('keeps approval-required handoffs visible across retries without calling them delivered', async () => {
    approved = false;
    for (let i = 0; i < 2; i++) {
      const result = await orchestrateFleet({ snapshot: snapshot(), events: [], apply: true }, options);
      expect(result).toMatchObject({ ok: false, assignments: [{ status: 'drafted' }] });
    }
    expect(posts()).toHaveLength(0);
  });
  it('refuses forged host sessions and releases unsent assignments for a later authenticated retry', async () => {
    const input = { snapshot: snapshot(), events: [], apply: true };
    expect((await orchestrateFleet(input, { ...options, session: { ...session(0), token: 'invalid' } })).ok).toBe(false);
    expect(posts()).toHaveLength(0);
    expect((await loadSpecialistRoster(directory)).specialists[0].currentJob).toBeNull();
    expect((await orchestrateFleet(input, options)).ok).toBe(true);
  });
  it('preserves lane holds, explicit allowlists and occupied specialist identities', async () => {
    const held = snapshot(); held.lanes[0].held = true;
    expect((await orchestrateFleet({ snapshot: held, events: [] }, options)).assignments).toEqual([]);
    const roster = await loadSpecialistRoster(directory); roster.specialists[0].allowedLanes = [];
    await saveSpecialistRoster(roster, directory);
    expect((await orchestrateFleet({ snapshot: snapshot(), events: [] }, options)).assignments[0].status).toBe('unassigned');
    roster.specialists[0].allowedLanes = ['codex']; roster.specialists[0].currentJob = 'MANUAL';
    await saveSpecialistRoster(roster, directory);
    expect((await orchestrateFleet({ snapshot: snapshot(), events: [] }, options)).assignments[0].status).toBe('unassigned');
    expect(call).not.toHaveBeenCalled();
  });
  it('fails closed on stale evidence, malformed receipts, concurrent writers and kill/pause', async () => {
    const input = { snapshot: snapshot(), events: [], apply: true };
    await expect(orchestrateFleet({ ...input, sourcesHealthy: false }, options)).rejects.toThrow('evidence');
    now += 60_001; await expect(orchestrateFleet(input, options)).rejects.toThrow('stale'); now -= 60_001;
    await writeFile(join(directory, 'orchestration.json'), '{}');
    await expect(orchestrateFleet(input, options)).rejects.toThrow();
    await rm(join(directory, 'orchestration.json'));
    await writeFile(join(directory, '.roster.lock'), '');
    await expect(orchestrateFleet(input, options)).rejects.toMatchObject({ code: 'EEXIST' });
    await rm(join(directory, '.roster.lock'));
    vi.mocked(localWriteGate).mockReturnValue({ status: 'refused', reason: 'paused' });
    await expect(orchestrateFleet(input, options)).rejects.toThrow('halted');
    expect(call).not.toHaveBeenCalled();
  });
  it('keeps crash reservations visible and does not replay a possibly admitted handoff', async () => {
    await orchestrateFleet({ snapshot: snapshot(), events: [], apply: true }, options);
    const path = join(directory, 'orchestration.json');
    const journal = JSON.parse(await readFile(path, 'utf8'));
    journal.receipts[0].status = 'reserved'; delete journal.receipts[0].delivery; delete journal.receipts[0].slack;
    await writeFile(path, JSON.stringify(journal));
    now += 120_000;
    const next = snapshot();
    next.outcomes = [{ job: 'RQ-A', lane: 'codex', phase: 'finish', result: 'success', at: at(-1000) }];
    const result = await orchestrateFleet({ snapshot: next, events: [], apply: true }, options);
    expect(result).toMatchObject({ ok: false, assignments: [{ status: 'reserved' }] });
    expect(posts()).toHaveLength(1);
    expect((await loadSpecialistRoster(directory)).specialists[0].currentJob).toBe('RQ-A');
  });
  it('does not free a specialist on a future finish or a different lane outcome', async () => {
    await orchestrateFleet({ snapshot: snapshot(), events: [], apply: true }, options);
    now += 120_000;
    const next = snapshot(); next.jobs = [job('RQ-B')];
    next.outcomes = [
      { job: 'RQ-A', lane: 'codex', phase: 'finish', result: 'success', at: at(1000) },
      { job: 'RQ-A', lane: 'other', phase: 'finish', result: 'success', at: at(-1000) },
    ];
    expect((await orchestrateFleet({ snapshot: next, events: [], apply: true }, options)).assignments[0].status).toBe('unassigned');
    expect(posts()).toHaveLength(1);
  });
  it('routes the CLI through fixture files and reports missing metrics as unknown', async () => {
    const file = join(root, 'snapshot.json'), out = vi.fn(), err = vi.fn();
    await writeFile(file, JSON.stringify(snapshot()));
    const deps = { ...options, now: () => new Date(now), runsDir: root, out, err };
    expect(await cmdFleetOrchestrate(['--snapshot', file, '--json'], deps)).toBe(1);
    expect(JSON.parse(out.mock.calls[0][0]).metrics).toMatchObject({ sourceState: 'missing', totals: null });
    await mkdir(join(root, 'metrics')); await writeFile(join(root, 'metrics/jobs.jsonl'), [...events(),
      { event: 'finish', job: 'HEALTH', lane: 'codex', ts: at(-1000), exit_code: 0, empty: false },
    ].map(e => JSON.stringify(e)).join('\n'));
    await mkdir(join(root, 'fleet'));
    await writeFile(join(root, 'queue/ready.tsv'), 'RQ-A\tphantom\tcodex\n');
    await writeFile(join(root, 'queue/slots.json'), JSON.stringify({ codex: { target: 2, ceiling: 2 } }));
    await writeFile(join(root, 'queue/resources.json'), JSON.stringify({ codex: { used_frac: 0, reset_at: at(3600_000) } }));
    await writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick: at(), paused: false, lanes: { codex: { held: false, running: 0 } } }));
    await writeFile(join(root, 'fleet/open-prs.json'), '[]');
    expect(await cmdFleetOrchestrate(['--json'], deps)).toBe(0);
    expect(JSON.parse(out.mock.calls.at(-1)![0]).assignments[0]).toMatchObject({ job: 'RQ-A', specialist: 'parser', status: 'proposed' });
    expect(await cmdFleetOrchestrate(['--snapshot', file, '--apply', '--json'], deps)).toBe(0);
    expect(posts()).toHaveLength(1);
    expect(await FLEET_SUBCOMMAND_LOADERS.orchestrate()).toHaveProperty('cmdFleetOrchestrate');
    for (const args of [['--top', '9'], ['--top', '0'], ['--apply', '--apply'], ['--dispatch'], ['--snapshot']]) {
      expect(await cmdFleetOrchestrate(args, deps)).toBe(2);
    }
    expect(await cmdFleetOrchestrate(['--help'], deps)).toBe(0);
  });
});
