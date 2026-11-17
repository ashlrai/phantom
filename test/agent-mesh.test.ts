import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishMeshObservation, readAgentMesh, MESH_FRESH_MS, MESH_TTL_MS, type MeshObservation } from '../src/core/agents/mesh.js';
import { publishAgentMesh, scheduleAgentMesh, type MeshPublisherOptions } from '../src/core/agents/mesh-publisher.js';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { localWriteGate } from '../src/core/agents/send-gate.js';
import { readAgentInbox, sendDirectMessage } from '../src/core/agents/bus-unified.js';
import { busBodySchema } from '../src/core/agents/bus-v2-schema.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { runAgentsCli } from '../src/cli/agents-bus-contract.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';

vi.mock('../src/core/agents/send-gate.js', () => ({ localWriteGate: vi.fn(() => null) }));
let root: string, now: number;
const options = () => ({ root, now: () => now });
const observation = (agent = 'claude'): MeshObservation => ({
  source: 'cli', agent, displayName: agent, lane: 'claude', provider: 'claude',
  lastSeen: now - 1000, currentTask: 'RQ-ONE', status: 'active', expiresAt: now + 60_000,
});
const sources = (): MeshPublisherOptions => ({
  ...options(), runsDir: root, claims: () => [{ agent: 'codex-personal', task: 'RQ-ONE', seen: now - 1000, until: now + 60_000 }],
  desktop: async () => ({ ok: true, sessions: ['devin', 'claude', 'codex', 'cursor', 'grok'].map(app => ({
    app, rosterApp: app as 'devin', bundleId: null, windowTitle: 'Review parser', sessionTitle: 'Review parser', lastActivity: null,
  })) }),
  loopSeen: () => now,
  teammates: () => ({ schema: 'imessage.teammate-tasks.v1', state: 'healthy', tasks: [{
    peer: 'dot', jobId: 'RQ-DOT', kind: 'report', repo: 'fake/repo', prRefs: [], deadline: new Date(now + 60_000).toISOString(),
    token: 'synthetic-result-token', createdAt: now - 1000, state: 'pending', metrics: [], settled: false,
    resource: 'imsg:dot', claimKey: 'queue:imsg.dot.RQ-DOT', result: null,
  }] }),
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-mesh-')); now = 1_800_000_000_000;
  vi.mocked(localWriteGate).mockReturnValue(null);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('flat agent mesh', () => {
  it('reads a missing mesh without writing and rejects unsupported CLI arguments', async () => {
    const out = vi.fn(), err = vi.fn();
    expect(await runAgentsCli(['mesh', 'status', '--root', root, '--json'], out, err)).toBe(0);
    expect(JSON.parse(out.mock.calls[0]![0])).toMatchObject({ status: 'ok', agents: [] });
    expect(readdirSync(root)).toEqual([]);
    expect(await runAgentsCli(['mesh', 'publish', '--json'], out, err)).toBe(2);
    expect(await runAgentsCli(['mesh', 'status', '--apply'], out, err)).toBe(2);
  });

  it('publishes every desktop app, CLI claims and teammate state as existing v2 context bodies', async () => {
    expect(await publishAgentMesh(sources())).toMatchObject({ status: 'ok', published: 8, failed: 0 });
    const mesh = readAgentMesh(options());
    expect(mesh.agents).toHaveLength(8);
    expect(mesh.agents.find(a => a.agent === 'codex-personal')).toMatchObject({ currentTask: 'RQ-ONE', lastSeen: now - 1000 });
    expect(mesh.agents.find(a => a.source === 'desktop' && a.lane === 'claude')).toMatchObject({ currentTask: 'Review parser', lastSeen: now });
    expect(mesh.agents.find(a => a.agent === 'imsg-dot')).toMatchObject({ currentTask: 'RQ-DOT', lastSeen: null, provider: 'openai-dot' });
    expect(mesh.agents.find(a => a.agent === 'imsg-instinct')).toMatchObject({ status: 'unknown', provider: null });
    const page = listBusInboxAfter(0, 100, options());
    if (page.status !== 'ok') throw new Error('fixture missing');
    expect(page.messages.every(m => busBodySchema.safeParse(m.envelope.body).success)).toBe(true);
    expect(JSON.stringify(page)).not.toContain('synthetic-result-token');
    expect(JSON.stringify(page)).not.toContain('imessage:');
  });

  it('makes observed agents directly addressable without a leader role or claim', async () => {
    await publishAgentMesh(sources());
    const grok = readAgentMesh(options()).agents.find(a => a.lane === 'grok')!.agent;
    const result = await sendDirectMessage({ from: 'imsg-dot', to: grok, text: 'Review RQ-ONE', wake: false }, options());
    expect(result.status).toBe('posted');
    const inbox = readAgentInbox(grok, {}, options());
    expect(inbox.status === 'ok' && inbox.messages.some(m => m.fromAgent === 'imsg-dot')).toBe(true);
  });

  it('retains all concurrent claims and reuses registered aliases without overwriting active state', async () => {
    registerAgentIdentity({ handle: 'reviewer', aliases: ['codex-personal'] }, options());
    const deps = sources();
    deps.claims = () => ['RQ-ONE', 'RQ-TWO'].map(task => ({ agent: 'codex-personal', task, seen: now - 1000, until: now + 60_000 }));
    await publishAgentMesh(deps);
    now += 1000;
    await publishAgentMesh(deps);
    const agents = readAgentMesh(options()).agents;
    expect(agents.find(a => a.agent === 'reviewer')).toMatchObject({ status: 'active', currentTask: 'RQ-ONE, RQ-TWO' });
    expect(agents.some(a => a.agent === 'codex-personal')).toBe(false);
  });

  it('reads actual claim-store metadata without tokens and clears expired leases', async () => {
    const claimed = acquireCoordination({ root, now, origin: 'resource', key: 'queue:RQ-REAL', owner: 'claude',
      leaseMs: 60000, leaseUntil: now + 60000, sourceId: 'RQ-REAL', started: new Date(now).toISOString() });
    expect(claimed.status).toBe('acquired');
    await publishAgentMesh({ ...sources(), claims: undefined, desktop: async () => ({ ok: true, sessions: [] }) });
    expect(readAgentMesh(options()).agents.find(a => a.agent === 'claude')).toMatchObject({ currentTask: 'queue:RQ-REAL', lastSeen: now });
    expect(readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8')).not.toContain(claimed.token);
    now += 60000;
    expect(readAgentMesh(options()).agents.find(a => a.agent === 'claude')).toMatchObject({ currentTask: null });
  });

  it('clears finished tasks, preserves last-seen, and distinguishes source failure from departure', async () => {
    await publishAgentMesh(sources());
    now += 1000;
    await publishAgentMesh({ ...sources(), claims: () => [], desktop: async () => ({ ok: false, code: 'denied', error: 'unavailable', sessions: [] }) });
    const agents = readAgentMesh(options()).agents;
    expect(agents.find(a => a.agent === 'codex-personal')).toMatchObject({ status: 'offline', currentTask: null, lastSeen: now - 2000 });
    expect(agents.find(a => a.lane === 'grok')).toMatchObject({ status: 'unknown', currentTask: null, lastSeen: now - 1000 });
  });

  it('expires claim tasks, ages presence and keeps known identities after bus retention', () => {
    publishMeshObservation(observation(), options());
    now += 60_000;
    expect(readAgentMesh(options()).agents[0]).toMatchObject({ status: 'offline', currentTask: null });
    now += MESH_FRESH_MS;
    expect(readAgentMesh(options()).agents[0]).toMatchObject({ status: 'unknown', lastSeen: now - 181_000 });
    now += MESH_TTL_MS;
    expect(readAgentMesh(options()).agents[0]).toMatchObject({ agent: 'claude', status: 'unknown', currentTask: null });
  });

  it('deduplicates repeated observations and scrubs task titles before persistence', () => {
    const secret = ['sk', 'synthetic'.repeat(6)].join('-');
    const row = { ...observation(), currentTask: 'Review ' + secret };
    expect(publishMeshObservation(row, options()).status).toBe('posted');
    expect(publishMeshObservation(row, options()).status).toBe('duplicate');
    const stored = readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8');
    expect(stored).not.toContain(secret);
    const before = stored;
    readAgentMesh(options());
    expect(readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8')).toBe(before);
  });

  it('keeps reads open during write holds and stops publication before any mutation', async () => {
    vi.mocked(localWriteGate).mockReturnValue({ status: 'refused', reason: 'Kill switch is on.' });
    expect(await publishAgentMesh(sources())).toMatchObject({ status: 'held', published: 0 });
    expect(publishMeshObservation(observation(), options()).status).toBe('refused');
    expect(readAgentMesh(options()).status).toBe('ok');
    expect(readdirSync(root)).toEqual([]);
    const controller = new AbortController(); controller.abort();
    expect(await publishAgentMesh({ ...sources(), signal: controller.signal })).toMatchObject({ status: 'held' });
    expect(scheduleAgentMesh()).toBeNull();
  });

  it('does not report stale teammate tasks as current or let malformed state crash a read', async () => {
    await publishAgentMesh({ ...sources(), loopSeen: () => now - MESH_FRESH_MS });
    expect(readAgentMesh(options()).agents.find(a => a.agent === 'imsg-dot')?.currentTask).toBeNull();
    writeFileSync(join(root, 'bus-inbox', 'messages.json'), '{broken');
    expect(readAgentMesh(options())).toMatchObject({ status: 'unavailable', agents: [] });
  });

  it('publishes other sources when the desktop hook stalls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = publishAgentMesh({ ...sources(), desktop: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await run).toMatchObject({ status: 'partial', sources: { desktop: false }, published: 3 });
    expect(readAgentMesh(options()).agents.find(a => a.agent === 'codex-personal')?.currentTask).toBe('RQ-ONE');
  });
  it('keeps concurrent desktop sessions individually addressable', async () => {
    const desktop = await sources().desktop!();
    desktop.sessions = [desktop.sessions[0]!, { ...desktop.sessions[0]!, windowTitle: 'Second task', sessionTitle: 'Second task' }];
    await publishAgentMesh({ ...sources(), desktop: async () => desktop });
    const sessions = readAgentMesh(options()).agents.filter(a => a.source === 'desktop');
    expect(new Set(sessions.map(a => a.address)).size).toBe(2);
    expect(sessions.map(a => a.currentTask).sort()).toEqual(['Review parser', 'Second task']);
  });
});
