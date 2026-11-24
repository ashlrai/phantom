/** RQ-PHX-DOTEVIDENCESLACKREPLY716: Dot's long live-evidence ask gets runtime identity, claims and the bridge owner in the same thread. Hermetic: fake ids/hosts, injected seams, temp dirs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { formatDotEvidenceReply } from '../src/core/comms/dot-evidence-reply.js';
import type { DotEvidencePacket } from '../src/core/comms/dot-evidence-packet.js';

vi.setConfig({ testTimeout: 30_000 });
const WAIT_MS = 15_000;
const RECHECK_TEXT = 'Phantom recheck, 2026-11-13T18:13:00.000Z\nRUNTIME VERIFIED host=mac-fake-1\nVerdict: UNKNOWN';
const EVIDENCE_ASK = 'Please recheck the current runtime rather than relying on yesterday’s blocked state. Return sanitized evidence of runtime identity, a fresh shared context/claims read, and the existing owner of the Dot bridge. If this worker still cannot reach live state, report the exact missing bridge.';
const configText = `[mason]\nidentities=[{channel="slack",id="U000FAKE01"}]\n[team]\nidentities=[{channel="slack",id="U000FAKE01"}]\n[slack]\nbridge_id="slack"\nteam_id="T000FAKE01"\nown_user_id="U000BOTFAKE"\nown_bot_id="B000FAKE01"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="C000FAKE01"\n`;

const claim = (n: number) => ({ id: `RQ-FAKE-${n}`, repo: 'phantom', task: `fake task ${n} `.repeat(30), agent: 'claude', expiresAt: '2026-11-13T20:00:00.000Z', state: 'RUNNING' as const });
const packet = (over: Partial<DotEvidencePacket> = {}): DotEvidencePacket => ({
  schema: 'fleet.dot-evidence.v1', asOf: '2026-11-13T18:13:00.000Z',
  runtime: { host: 'mac-fake-1', installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false, fleetState: { ageSeconds: 12, stale: false } },
  tailnet: { state: 'unavailable' }, claims: { claims: [claim(1), claim(2)] }, slack: { state: 'unavailable' },
  bridge: { owner: 'agent-fake', transport: { phantomToDot: 'fake-transport', teammateTransport: 't', hostQualification: 'h' } },
  missing: [], ...over,
});

describe('formatDotEvidenceReply', () => {
  it('renders the full packet', () => {
    const text = formatDotEvidenceReply(packet());
    expect(text.split('\n')).toEqual([
      'Phantom evidence as of 2026-11-13T18:13:00.000Z (read-only, grants nothing)',
      'Runtime: mac-fake-1 installed 1.2.3 source 1.2.3 fleet-state 12s',
      'Claims: 2 live',
      '- RQ-FAKE-1 phantom claude RUNNING until 2026-11-13T20:00:00.000Z',
      '- RQ-FAKE-2 phantom claude RUNNING until 2026-11-13T20:00:00.000Z',
      'Bridge owner: agent-fake', 'Transport: fake-transport', 'Missing: none']);
  });
  it('flags drift and stale fleet state', () => {
    const p = packet(); if ('state' in p.runtime) throw new Error('fixture');
    const text = formatDotEvidenceReply({ ...p, runtime: { ...p.runtime, versionDrift: true, fleetState: { ageSeconds: 900, stale: true } } });
    expect(text).toContain('source 1.2.3 drift fleet-state 900s STALE');
  });
  it('names runtime and claims as unavailable with the missing list', () => {
    const text = formatDotEvidenceReply(packet({ runtime: { state: 'unavailable' }, claims: { state: 'unavailable' }, missing: ['runtime-identity-unavailable', 'claims-store-unreadable'] }));
    expect(text).toContain('Runtime: UNAVAILABLE');
    expect(text).toContain('Claims: UNAVAILABLE');
    expect(text).toContain('Missing: runtime-identity-unavailable, claims-store-unreadable');
  });
  it('says unknown when the bridge owner is unknown', () => {
    const p = packet(); const text = formatDotEvidenceReply({ ...p, bridge: { ...p.bridge, owner: 'unknown' }, missing: ['bridge-owner-unknown'] });
    expect(text).toContain('Bridge owner: unknown');
    expect(text).toContain('Missing: bridge-owner-unknown');
  });
  it('keeps 40 claims under the cap, shows at most 5, and still ends with Missing', () => {
    const text = formatDotEvidenceReply(packet({ claims: { claims: Array.from({ length: 40 }, (_, i) => claim(i)) }, missing: ['tailnet-unavailable'] }));
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text).toContain('Claims: 40 live');
    expect(text.split('\n').filter(l => l.startsWith('- '))).toHaveLength(5);
    expect(text.split('\n').at(-1)).toBe('Missing: tailnet-unavailable');
    expect(text).toContain('Runtime: mac-fake-1');
    expect(text).toContain('Bridge owner: agent-fake');
  });
  it('never carries an absolute path or control characters', () => {
    const p = packet(); const text = formatDotEvidenceReply({ ...p, bridge: { ...p.bridge, owner: '/Users/fake/secret\nowner' } });
    expect(text).not.toMatch(/\/Users\//);
    expect(text).not.toContain('secret');
    expect(text.split('\n')).toHaveLength(8);
  });
});

describe('long owner evidence ask over Slack with evidence', () => {
  let root: string;
  let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'slack-evidence-c716-'));
    options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-13T18:13:00Z') };
    mkdirSync(options.configDir, { mode: 0o700 });
    writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const slackEvent = (text: string, eventId: string) => ({ type: 'events_api', envelope_id: `${eventId}-delivery`, payload: { team_id: 'T000FAKE01', event_id: eventId, event: {
    type: 'message', user: 'U000FAKE01', channel: 'C000FAKE01', ts: '1793920001.000001', thread_ts: '1793920000.000001', text } } });
  const fakeCall = (): SlackCall => vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: 'T000FAKE01', user_id: 'U000BOTFAKE', bot_id: 'B000FAKE01' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: false, is_channel: true, context_team_id: 'T000FAKE01' } };
    if (method === 'conversations.members') return { members: ['U000BOTFAKE', 'U000FAKE01'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T000FAKE01', is_bot: false } };
    if (method === 'chat.postMessage') return { channel: body.channel, ts: `${options.now() / 1000 + 1}.000001` };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
  const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');
  async function ask(deps: Parameters<typeof ownerStatusReply>[0]): Promise<string> {
    const call = fakeCall(); let settled = false;
    const policy = readSlackDeliveryPolicy(options)!;
    const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: ownerStatusReply(deps) });
    const handlers: Record<string, (event: { data?: unknown }) => void> = {};
    const socket = { readyState: 1, addEventListener: (type: string, cb: (event: { data?: unknown }) => void) => { handlers[type] = cb; }, send: vi.fn(), close: vi.fn() };
    await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot, now: () => new Date(options.now()) },
      leaderAdapter: { ...adapter, route: async envelope => { try { return await adapter.route(envelope); } finally { settled = true; } } }, connect: () => socket });
    handlers.message!({ data: JSON.stringify(slackEvent(EVIDENCE_ASK, 'Ev-c716')) });
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: WAIT_MS });
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });
    return String(posts(call)[0]?.[1]?.text);
  }

  it('posts one reply with the recheck line and the evidence block', async () => {
    const evidence = vi.fn(async () => formatDotEvidenceReply(packet()));
    const text = await ask({ recheck: async () => RECHECK_TEXT, evidence });
    expect(text).toContain('Phantom recheck (full message recorded for the Leader):\n' + RECHECK_TEXT);
    expect(text).toContain('Bridge owner: agent-fake');
    expect(text).toContain('Claims: 2 live');
    expect(text).toContain('Runtime: mac-fake-1');
    expect(evidence).toHaveBeenCalledOnce();
    console.log(text);
  });
  it('posts exactly today\'s text without an evidence seam', async () => {
    const text = await ask({ recheck: async () => RECHECK_TEXT });
    expect(text).toBe('Leader: Phantom recheck (full message recorded for the Leader):\n' + RECHECK_TEXT);
  });
  it('keeps the recheck text when evidence throws', async () => {
    const text = await ask({ recheck: async () => RECHECK_TEXT, evidence: async () => { throw new Error('/Users/fake/boom'); } });
    expect(text).toContain(RECHECK_TEXT);
    expect(text).not.toContain('boom');
    expect(text).toContain('Phantom evidence: the evidence read failed');
  });
});
