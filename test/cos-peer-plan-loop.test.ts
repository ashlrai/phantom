/** CoS peer plans through the standard loop (RQ-ORCH-PEERPLAN-1). Hermetic: faked runner, faked peer transport, tmp dirs. */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/agents/send-gate.js', () => ({ localWriteGate: vi.fn(() => null) }));
vi.mock('../src/core/agentnet/peer-bus.js', async (original) => ({
  ...(await original<typeof import('../src/core/agentnet/peer-bus.js')>()),
  sendPeerMessage: vi.fn(async () => ({ status: 'posted', id: `peer-${crypto.randomUUID()}`, slack: 'sent' })),
}));

import { sendPeerMessage } from '../src/core/agentnet/peer-bus.js';
import { localWriteGate } from '../src/core/agents/send-gate.js';
import { runCosLoop } from '../src/core/cos/loop.js';
import { emitCosPeerPlanOnce } from '../src/core/cos/peer-plan.js';
import { queueCosEnvelope } from '../src/core/cos/intake.js';
import { runCosWorkOnce } from '../src/core/cos/worker.js';
import { journalSchema } from '../src/core/fleet/orchestration-journal.js';
import type { SpawnedPlannerProcess, SpawnLike } from '../src/core/fleet/planner-run.js';
import { readFleetOrchestration } from '../src/mcp/fleet-orchestration-read.js';

const session = { lane: 'cos-lane', sessionId: 'cos-session', token: 'synthetic-session-' + 'a'.repeat(32) };
const candidates = [{ provider: 'fake', argv: ['fake-cli'] }];
let root: string, runsDir: string, directory: string, bindings: string;

const binding = (callsign: string, lane: string, sessionId: string, expiresAt = Date.now() + 3_600_000) => ({
  callsign, lane, sessionId, expiresAt, teamId: 'TTEAM', userId: `U${callsign.toUpperCase()}`, botId: `B${callsign.toUpperCase()}`, topic: 'mesh',
  sessionHash: createHash('sha256').update(JSON.stringify([lane, sessionId, lane === session.lane ? session.token : 'x'])).digest('hex'),
});
const writeBindings = (peers: unknown[]) => writeFileSync(bindings, JSON.stringify({ version: 1, peers }), { mode: 0o600 });

function runner(output: string): SpawnLike {
  return () => {
    const events = new EventEmitter(), stdin = new PassThrough(), stdout = new PassThrough();
    const proc = { stdin, stdout, stderr: new PassThrough(), kill: () => true,
      on: (e: string, l: (...a: never[]) => void) => { events.on(e, l); return proc; },
      once: (e: string, l: (...a: never[]) => void) => { events.once(e, l); return proc; } } as unknown as SpawnedPlannerProcess;
    stdin.on('finish', () => { stdout.end(output); stdout.once('end', () => setImmediate(() => events.emit('close', 0, null))); });
    return proc;
  };
}
const plan = (peers: unknown[] = [{ toAgent: 'dot', kind: 'task', text: 'Review the parser change', refs: ['pr:12'] }], extra = {}) =>
  JSON.stringify({ reply: 'Handing the parser review to dot.', peers, ...extra });
const enqueue = () => queueCosEnvelope({ channel: 'cli', verifiedSenderId: 'cos-local', body: 'Get the parser reviewed',
  receivedAt: new Date().toISOString(), dedupeKey: 'b'.repeat(64) }, runsDir);
const loop = (output: string, apply: boolean, maxPasses = 2) => runCosLoop({
  durationMs: 60_000, maxPasses, runsDir, intervalMs: 5_000, sleep: async () => {},
  peerPlan: { session, apply, directory, options: { bindings, busRoot: root, runsDir: root } },
  work: opts => runCosWorkOnce({ ...opts, spawn: runner(output), candidates, home: root }),
});
const journal = () => journalSchema.parse(JSON.parse(readFileSync(join(directory, 'orchestration.json'), 'utf8')));
const sends = () => vi.mocked(sendPeerMessage).mock.calls.length;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cos-peerplan-')); runsDir = join(root, 'runs'); directory = join(root, 'specialists');
  mkdirSync(runsDir); mkdirSync(directory); bindings = join(root, 'bindings.json');
  writeBindings([binding('cos', session.lane, session.sessionId), binding('dot', 'dot-lane', 'dot-session')]);
  vi.mocked(sendPeerMessage).mockClear();
  vi.mocked(localWriteGate).mockReturnValue(null);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('cos-loop peer plans', () => {
  it('sends exactly one bounded message, journals it, and never duplicates', async () => {
    await enqueue();
    const summary = await loop(plan(undefined, { deadline: new Date(Date.now() + 86_400_000).toISOString() }), true);
    expect(summary).toMatchObject({ drafted: 1, idle: 1 });
    expect(sends()).toBe(1);
    const [request] = vi.mocked(sendPeerMessage).mock.calls[0]! as [{ toAgent: string; text: string; refs: string[] }];
    expect(request.toAgent).toBe('dot');
    expect(request.text).toContain('no execution, merge or spending authority');
    expect(request.text).toContain('wanted by');
    const [receipt] = journal().receipts;
    expect(receipt).toMatchObject({ lane: 'cos', specialist: 'chief-of-staff', status: 'complete', delivery: '1/1 admitted' });
    expect(receipt!.peerMessages).toHaveLength(1);
    expect(request.refs).toContain(receipt!.job);
    // A repeat for the same work item is recorded as a duplicate and sends nothing.
    const again = await emitCosPeerPlanOnce({ reply: 'x', peers: [{ toAgent: 'dot', kind: 'task', text: 'again', refs: [] }] }, receipt!.job,
      { session, apply: true, directory, options: { bindings, busRoot: root } });
    expect(again).toMatchObject({ status: 'duplicate', messages: receipt!.peerMessages });
    expect(sends()).toBe(1);
    expect(journal().receipts).toHaveLength(1);
  });

  it('shows the plan through fleet_orchestration_read', async () => {
    const home = join(root, 'home'), dir = join(home, '.ashlr-runs', 'queue', 'specialists');
    mkdirSync(dir, { recursive: true });
    vi.stubEnv('HOME', home);
    await enqueue();
    await runCosLoop({ durationMs: 60_000, maxPasses: 1, runsDir, sleep: async () => {},
      peerPlan: { session, apply: true, directory: dir, options: { bindings, busRoot: root, runsDir: root } },
      work: opts => runCosWorkOnce({ ...opts, spawn: runner(plan()), candidates, home: root }) });
    const read = await readFleetOrchestration({ limit: 10 });
    expect(read.counts.complete).toBe(1);
    expect(read.receipts[0]).toMatchObject({ lane: 'cos', status: 'complete' });
    expect(read.receipts[0]!.peerMessages).toHaveLength(1);
  });

  it('is a dry run by default: nothing sent, nothing written', async () => {
    await enqueue();
    const events: Array<string | undefined> = [];
    const summary = await runCosLoop({ durationMs: 60_000, maxPasses: 1, runsDir, sleep: async () => {},
      onPass: e => { events.push(e.peerPlan); },
      peerPlan: { session, directory, options: { bindings, busRoot: root, runsDir: root } },
      work: opts => runCosWorkOnce({ ...opts, spawn: runner(plan()), candidates, home: root }) });
    expect(summary.drafted).toBe(1);
    expect(events).toEqual(['dry-run']);
    expect(sends()).toBe(0);
    expect(() => journal()).toThrow();
  });

  describe('suppression', () => {
    const run = async (output = plan()) => {
      await enqueue();
      let status: string | undefined;
      await runCosLoop({ durationMs: 60_000, maxPasses: 1, runsDir, sleep: async () => {},
        onPass: e => { status = e.peerPlan; },
        peerPlan: { session, apply: true, directory, options: { bindings, busRoot: root, runsDir: root } },
        work: opts => runCosWorkOnce({ ...opts, spawn: runner(output), candidates, home: root }) });
      return status;
    };

    it('KILL / comms-paused (send gate) sends nothing and says halted', async () => {
      vi.mocked(localWriteGate).mockReturnValue({ status: 'refused', reason: 'Kill switch is on.' });
      expect(await run()).toBe('halted');
      expect(sends()).toBe(0);
      expect(() => journal()).toThrow();
    });

    it('missing bindings file is a clean no-op', async () => {
      rmSync(bindings);
      expect(await run()).toBe('no-identities');
      expect(sends()).toBe(0);
    });

    it('empty or expired identities send nothing', async () => {
      writeBindings([binding('cos', session.lane, session.sessionId, Date.now() - 1)]);
      expect(await run()).toBe('no-identities');
      expect(sends()).toBe(0);
    });

    it('never sends to unregistered peers or to channels', async () => {
      expect(await run(plan([{ toAgent: 'ghost', kind: 'task', text: 'hi', refs: [] },
        { channel: 'CMESH', kind: 'task', text: 'hi', refs: [] }]))).toBe('no-registered-peers');
      expect(sends()).toBe(0);
    });

    it('refuses a past or too-distant deadline', async () => {
      expect(await run(plan(undefined, { deadline: new Date(Date.now() - 1000).toISOString() }))).toBe('deadline-invalid');
      expect(sends()).toBe(0);
    });
  });

  it('drops only the unregistered recipient from a mixed plan', async () => {
    const outcome = await emitCosPeerPlanOnce({ reply: 'x', peers: [
      { toAgent: 'ghost', kind: 'task', text: 'a', refs: [] }, { toAgent: 'dot', kind: 'task', text: 'b', refs: [] }] },
    'cos-' + 'c'.repeat(32), { session, apply: true, directory, options: { bindings, busRoot: root } });
    expect(outcome).toMatchObject({ status: 'sent', requested: 2, skipped: 1 });
    expect(sends()).toBe(1);
  });

  it('records nothing when the bus admits no message', async () => {
    vi.mocked(sendPeerMessage).mockResolvedValueOnce({ status: 'refused', reason: 'unknown-peer' });
    const outcome = await emitCosPeerPlanOnce({ reply: 'x', peers: [{ toAgent: 'dot', kind: 'task', text: 'b', refs: [] }] },
      'cos-' + 'd'.repeat(32), { session, apply: true, directory, options: { bindings, busRoot: root } });
    expect(outcome.status).toBe('refused');
    expect(journal().receipts).toHaveLength(0);
  });
});

describe('orchestration journal compatibility', () => {
  it('still validates journals written before peerMessages existed', () => {
    const old = { version: 1, receipts: [{ key: 'a'.repeat(64), job: 'j1', lane: 'work', specialist: 's1',
      assignedAt: '2026-11-01T00:00:00.000Z', status: 'admitted', delivery: 'posted', slack: 'sent' }] };
    expect(journalSchema.parse(old).receipts[0]!.peerMessages).toBeUndefined();
  });

  it('rejects a malformed peerMessages reference', () => {
    expect(() => journalSchema.parse({ version: 1, receipts: [{ key: 'a'.repeat(64), job: 'j', lane: 'cos', specialist: 's',
      assignedAt: '2026-11-01T00:00:00.000Z', status: 'complete', peerMessages: ['not-an-id'] }] })).toThrow();
  });
});

describe('fleet cos-loop --peer-plan flags', () => {
  it('requires the session env and refuses --peer-apply without --peer-plan', async () => {
    const { cmdFleetCosLoop } = await import('../src/cli/fleet-cos-loop.js');
    const err: string[] = [];
    const base = { error: (t: string) => err.push(t), output: () => {} };
    expect(await cmdFleetCosLoop(['--duration-ms', '1000', '--peer-apply'], base)).toBe(2);
    expect(await cmdFleetCosLoop(['--duration-ms', '1000', '--peer-plan'], { ...base, env: {} })).toBe(2);
    expect(err.join('\n')).toContain('ASHLR_COS_PEER_TOKEN');
    let seen: unknown;
    const env = { ASHLR_COS_PEER_LANE: 'l', ASHLR_COS_PEER_SESSION: 's', ASHLR_COS_PEER_TOKEN: 't'.repeat(40) };
    expect(await cmdFleetCosLoop(['--duration-ms', '1000', '--max-passes', '1', '--peer-plan', '--runs-dir', runsDir],
      { ...base, env, work: async (o) => { seen = o.peerPlan; return { outcome: 'idle' }; }, sleep: async () => {} })).toBe(0);
    expect(seen).toMatchObject({ apply: false, session: { lane: 'l', sessionId: 's' } });
  });
});
