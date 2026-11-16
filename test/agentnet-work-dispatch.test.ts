import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumePeerWork } from '../src/core/agentnet/work-dispatch.js';
import { sendPeerMessage } from '../src/core/agentnet/peer-bus.js';
import { workResultBodySchema } from '../src/core/agents/bus-v2-schema.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { QueueStore } from '../src/core/queue/store.js';
import { cmdAgentnet } from '../src/cli/agentnet.js';

let root: string, now: number, store: QueueStore;
const session = (n = 0) => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-` + 'a'.repeat(32) });
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const options = () => ({ bindings: join(root, 'bindings.json'), busRoot: root, runsDir: root, now: () => now });
const work = () => ({ kind: 'work.post' as const, jobId: 'RQ-DOCS', title: 'Fix spelling', repo: 'ashlrai/phantom',
  claimKeys: ['queue:RQ-DOCS', 'path:ashlrai/phantom:docs/AGENT-BUS.md'],
  dispatch: { tier: 'fast' as const, scope: 'Fix spelling in the bus guide.', acceptance: 'Documentation links pass.' } });
const policy = () => ({ version: 1, enabled: true, peers: ['agent0', 'agent1', 'agent2'],
  repositories: [{ repo: 'ashlrai/phantom', tierCeiling: 'mid', paths: ['docs/AGENT-BUS.md'] }] });
const write = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value), { mode: 0o600 });
const journal = () => JSON.parse(readFileSync(join(root, 'agentnet/work-dispatch.json'), 'utf8'));
const messages = () => {
  const page = listBusInboxAfter(0, 100, { root, now: () => now });
  if (page.status !== 'ok') throw new Error('fixture bus unavailable');
  return page.messages;
};
const replies = () => messages().filter(m => (m.envelope.body as { kind?: string }).kind === 'work.result');
// Private admission fixtures also exercise malformed durable messages; raw bus writes alone do not qualify.
function admit(body: unknown = work(), target = 'agent1', peer = 'agent0', authenticated = true) {
  const envelope = { id: `peer-${randomUUID()}`, from: peer, to: target, priority: 'P2' as const, ttl: 86_400_000, body };
  expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
  if (authenticated) {
    const name = 'agentnet/coordination.json';
    const rows = existsSync(join(root, name)) ? JSON.parse(readFileSync(join(root, name), 'utf8')) : [];
    write(name, [...rows, { id: envelope.id, fromAgent: peer, target, origin: envelope.id,
      digest: hash(envelope), hopCount: 1, threadId: envelope.id, at: now }]);
  }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-work-')); now = Date.now();
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  mkdirSync(join(root, '.ashlr'), { mode: 0o700 }); mkdirSync(join(root, 'agentnet'), { mode: 0o700 });
  write('bindings.json', { version: 1, peers: Array.from({ length: 3 }, (_, n) => ({ callsign: `agent${n}`,
    lane: session(n).lane, sessionId: session(n).sessionId,
    sessionHash: hash([session(n).lane, session(n).sessionId, session(n).token]), expiresAt: now + 3_600_000,
    teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh' })) });
  write('dispatch.json', policy());
  writeFileSync(join(root, '.ashlr/comms.toml'), 'confirmedByMason = true\n', { mode: 0o600 });
  writeFileSync(join(root, '.ashlr/agent-network.toml'), '[team]\nidentities = [' +
    [0, 1, 2].map(n => `{ channel = "bus", id = "agent${n}" }`).join(',') + ']\n', { mode: 0o600 });
  store = new QueueStore(join(root, 'queue'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('bounded peer work feed dispatch', () => {
  it('posts through authenticated peer admission, previews without writes, then exclusively claims and replies', async () => {
    const posted = await sendPeerMessage({ toAgent: 'agent1', kind: 'task', text: 'Proposed work', work: work() }, session(), {
      ...options(), readPolicy: () => ({ config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: 'UAGENT0', ownBotId: 'BAGENT0',
        botTokenRef: 'phm_TEST_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] }, confirmedByMason: false,
      teamIdentities: [0, 1, 2].map(n => ({ channel: 'slack' as const, id: `UAGENT${n}` })) }),
      call: async (method, args) => method === 'conversations.info'
        ? { channel: { id: 'CMESH', is_channel: true, is_shared: false, is_ext_shared: false, is_pending_ext_shared: false, context_team_id: 'TTEAM' } }
        : method === 'conversations.members' ? { members: ['UAGENT0', 'UAGENT1', 'UAGENT2'] }
          : { user: { id: args?.user, team_id: 'TTEAM', is_bot: true } },
    });
    expect(posted.status).toBe('drafted');
    expect(await consumePeerWork(session(1), {}, options())).toMatchObject({ dryRun: true, results: [{ status: 'proposed' }] });
    expect(existsSync(store.path)).toBe(false); expect(existsSync(join(root, 'agentnet/work-dispatch.json'))).toBe(false);
    expect(await consumePeerWork(session(1), { apply: true }, options())).toMatchObject({ results: [{ status: 'admitted' }] });
    expect((await store.read()).jobs).toMatchObject([{ status: 'CLAIMED', exclusive: true, claims: [{ owner: 'peer:agent0' }] }]);
    expect(replies().map(m => workResultBodySchema.parse(m.envelope.body).outcome)).toEqual(['reserved', 'admitted']);
    expect(replies().every(m => m.envelope.to === 'agent0')).toBe(true);
    expect(JSON.stringify(journal())).not.toContain(work().dispatch.scope);
  });
  it('deduplicates replays and competing consumers across different message ids', async () => {
    admit(); admit(work(), 'agent2');
    await Promise.all([1, 2].map(n => consumePeerWork(session(n), { apply: true }, options())));
    for (const n of [1, 2]) await consumePeerWork(session(n), { apply: true }, options());
    const jobs = (await store.read()).jobs;
    expect(jobs).toHaveLength(1); expect(jobs[0]!.claims).toHaveLength(1); expect(journal().receipts).toHaveLength(1);
    expect(replies()).toHaveLength(2);
    admit({ ...work(), title: 'Changed identity contents' });
    expect((await consumePeerWork(session(1), { apply: true }, options())).results).toContainEqual(expect.objectContaining({ reason: 'claim-conflict' }));
  });
  it.each([
    [{ repo: 'other/repo' }, 'repo-not-allowed'],
    [{ dispatch: { ...work().dispatch, tier: 'frontier' } }, 'tier-ceiling'],
    [{ claimKeys: ['queue:RQ-DOCS', 'path:ashlrai/phantom:src/core/authority/policy.ts'] }, 'paths-not-allowed'],
    [{ claimKeys: ['queue:RQ-DOCS', 'path:ashlrai/phantom:docs/**'] }, 'paths-not-allowed'],
    [{ dispatch: { ...work().dispatch, scope: 'x'.repeat(4001) } }, 'invalid-work-post'],
    [{ dispatch: { ...work().dispatch, scope: 'x'.repeat(4000) } }, 'invalid-prompt'],
    [{ dispatch: { ...work().dispatch, command: 'touch /tmp/peer-must-not-run' } }, 'invalid-work-post'],
    [{ dispatch: { ...work().dispatch, scope: 'bad\0text' } }, 'invalid-prompt'],
    [{ dispatch: { ...work().dispatch, acceptance: 'ghp_' + 'a'.repeat(30) } }, 'invalid-prompt'],
  ])('refuses unsafe work %j with a bounded reason', async (patch, reason) => {
    admit({ ...work(), ...patch });
    expect(await consumePeerWork(session(1), { apply: true }, options())).toMatchObject({ results: [{ status: reason === 'invalid-work-post' ? 'refused' : 'failed', reason }] });
    expect((await store.read()).jobs).toHaveLength(0);
    for (const reply of replies()) expect(workResultBodySchema.safeParse(reply.envelope.body).success).toBe(true);
  });
  it.each(['kill', 'comms', 'allowlist', 'disabled'])('%s blocks every claim and result send', async gate => {
    admit();
    if (gate === 'kill') writeFileSync(join(root, '.ashlr/KILL'), 'halt');
    if (gate === 'comms') writeFileSync(join(root, '.ashlr/comms.toml'), 'confirmedByMason = false\n');
    if (gate === 'allowlist') writeFileSync(join(root, '.ashlr/agent-network.toml'), '[team]\nidentities = []\n');
    if (gate === 'disabled') write('dispatch.json', { ...policy(), enabled: false });
    expect((await consumePeerWork(session(1), { apply: true }, options())).status).toBe('refused');
    expect((await store.read()).jobs).toHaveLength(0); expect(replies()).toHaveLength(0);
    expect(existsSync(join(root, 'agentnet/work-dispatch.json'))).toBe(false);
  });
  it('ignores unauthenticated labels and peer status claims', async () => {
    admit(work(), 'agent1', 'agent0', false);
    admit({ kind: 'work.status', jobId: work().jobId, status: 'done' });
    expect(await consumePeerWork(session(1), { apply: true }, options())).toMatchObject({ results: [] });
    expect((await store.read()).jobs).toHaveLength(0); expect(replies()).toHaveLength(0);
  });
  it('recovers a crash after the queue commit without taking a second claim', async () => {
    admit(); const original = QueueStore.prototype.claim;
    const crash = vi.spyOn(QueueStore.prototype, 'claim').mockImplementationOnce(async function (this: QueueStore, ...args) {
      await original.apply(this, args); throw new Error('simulated crash');
    });
    expect((await consumePeerWork(session(1), { apply: true }, options())).status).toBe('refused'); crash.mockRestore();
    expect(journal().receipts[0].outcome).toBe('reserved');
    expect(await consumePeerWork(session(1), { apply: true }, options())).toMatchObject({ results: [{ status: 'duplicate' }] });
    expect(journal().receipts[0].outcome).toBe('admitted');
    expect((await store.read()).jobs[0]!.claims).toHaveLength(1); expect(replies()).toHaveLength(2);
  });
  it('rechecks KILL inside the queue lock and leaves no READY job behind', async () => {
    admit(); const original = QueueStore.prototype.claim;
    vi.spyOn(QueueStore.prototype, 'claim').mockImplementationOnce(async function (this: QueueStore, ...args) {
      writeFileSync(join(root, '.ashlr/KILL'), 'halt'); return original.apply(this, args);
    });
    expect((await consumePeerWork(session(1), { apply: true }, options())).status).toBe('refused');
    expect((await store.read()).jobs).toHaveLength(0);
    expect(replies().map(m => workResultBodySchema.parse(m.envelope.body).outcome)).toEqual(['reserved']);
  });
  it.each([false, true])('reports terminal queue state after cursor advance (failure=%s)', async failed => {
    admit(); await consumePeerWork(session(1), { apply: true }, options());
    const job = (await store.read()).jobs[0]!;
    await store.finish(job.id, 'peer:agent0', failed ? { reason: 'Execution failed' } : {});
    // Cursor advance cannot hide terminal reconciliation.
    await consumePeerWork(session(1), { apply: true, after: messages().at(-1)!.cursor }, options());
    expect(workResultBodySchema.parse(replies().at(-1)!.envelope.body).outcome).toBe(failed ? 'failed' : 'complete');
    await consumePeerWork(session(1), { apply: true }, options()); expect(replies()).toHaveLength(3);
  });
  it('recovers reserved queue evidence after the original feed and admission receipt expire', async () => {
    admit(); const original = QueueStore.prototype.claim;
    const crash = vi.spyOn(QueueStore.prototype, 'claim').mockImplementationOnce(async function (this: QueueStore, ...args) {
      await original.apply(this, args); throw new Error('simulated crash');
    });
    expect((await consumePeerWork(session(1), { apply: true }, options())).status).toBe('refused'); crash.mockRestore();
    now += 86_400_001;
    const bindings = JSON.parse(readFileSync(join(root, 'bindings.json'), 'utf8'));
    for (const peer of bindings.peers) peer.expiresAt = now + 3_600_000;
    write('bindings.json', bindings);
    expect(await consumePeerWork(session(1), { apply: true }, options())).toMatchObject({ status: 'ok', results: [] });
    expect(journal().receipts[0].outcome).toBe('admitted');
    expect((await store.read()).jobs[0]!.claims).toHaveLength(1);
    expect(replies()).toHaveLength(1);
  });
  it('wires CLI preview/apply and refuses message-selected policy flags', async () => {
    admit(); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdAgentnet(['peers', 'dispatch', '--json'], options(), session(1))).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).dryRun).toBe(true);
    expect(await cmdAgentnet(['peers', 'dispatch', '--apply', '--json'], options(), session(1))).toBe(0);
    expect((await store.read()).jobs).toHaveLength(1);
    expect(await cmdAgentnet(['peers', 'dispatch', '--policy', 'untrusted'], options(), session(1))).toBe(2);
  });
  it('keeps legacy work posts coordination-only and rejects secret-shaped or malformed job ids', async () => {
    const { dispatch: _dispatch, ...legacy } = work();
    admit(legacy); admit({ ...work(), jobId: 'RQ-DOCS\n' }); admit({ ...work(), jobId: 'ghp_' + 'a'.repeat(30) });
    expect((await consumePeerWork(session(1), { apply: true }, options())).results.map(r => r.status)).toEqual(['ignored', 'refused', 'refused']);
    expect((await store.read()).jobs).toHaveLength(0); expect(replies()).toHaveLength(0);
  });
  it('uses the queue lock itself to reject competing atomic intakes without replacing an existing job', async () => {
    const job = { id: 'atomic-peer', status: 'READY' as const, priority: 'P2', repo: 'ashlrai/phantom', tier: 'fast',
      scope: 'Bounded task', acceptance: 'Pass', claims: [], deps: [] };
    const results = await Promise.allSettled([0, 1].map(n => store.claim(job.id, `peer:agent${n}`, { job, guard: () => {} })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await store.read()).jobs[0]!.claims).toHaveLength(1);
    await expect(store.claim('other', 'peer:agent0', { job, guard: () => {} })).rejects.toThrow('Invalid claim intake');
    expect((await store.read()).jobs).toHaveLength(1);
  });
});
