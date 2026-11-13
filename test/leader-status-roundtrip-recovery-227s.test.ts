import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { classifyIntentByRules } from '../src/core/vision/leader-intent.js';
import { createLeaderNetwork } from '../src/core/agents/leader-network.js';
import { tickLeaderNetwork } from '../src/core/agents/leader-network-runtime.js';

const configText = '[mason]\nidentities=[{channel="slack",id="U0OWNER"},{channel="bus",id="local-owner"}]\n[team]\nidentities=[{channel="slack",id="U0OWNER"},{channel="bus",id="local-owner"}]\n';
const BRIEF = 'Synthetic status brief';
let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const sent: BusEnvelope[] = [];
const deliver = vi.fn(async (_identity: unknown, envelope: BusEnvelope) => { sent.push(envelope); return { status: 'sent' as const, reason: 'Synthetic delivery' }; });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'leader-status-227s-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-12T12:00:00Z') };
  mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  sent.length = 0;
  deliver.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function request(id: string, text: string, channel: 'slack' | 'bus', identity: string, senderId = 'mason') {
  const sources = { configSource: configText, commsSource: 'confirmedByMason=true\n' };
  const result = await createLeaderNetwork({ ...sources, runsDir: options.runsDir, busRoot: options.busRoot, now: options.now }).ingest({
    message: { id, from: senderId, to: 'leader', priority: 'P0', ttl: 100000, body: { text }, channel, channel_ref: `synthetic-${id}`,
      sender: { agent_id: senderId, vendor: 'fixture', human: true, team: true }, external: false },
    verifiedSender: { channel, id: identity } });
  return result;
}
const slackRequest = (id: string, text: string) => request(id, text, 'slack', 'U0OWNER');
const tick = (deps: Parameters<typeof tickLeaderNetwork>[2]) => tickLeaderNetwork({} as AshlrConfig, options, { deliver, ...deps });
const bodyText = (envelope: BusEnvelope) => (envelope.body as { text: string }).text;

describe('status intent with a leading address word', () => {
  it.each(['Phantom status', 'phantom: status?', 'Leader, sitrep', 'LEADER status!', 'phantom /status'])('%s is status', text => {
    expect(classifyIntentByRules(text).kind).toBe('status');
  });
  it.each(['status', '/status', 'sitrep?', "what's up"])('bare %s stays status', text => {
    expect(classifyIntentByRules(text).kind).toBe('status');
  });
  it('does not treat a longer sentence as status', () => {
    expect(classifyIntentByRules('phantom status page is broken, fix it').kind).not.toBe('status');
    expect(classifyIntentByRules('phantom phantom status').kind).not.toBe('status');
  });
});

describe('instant status brief without a model', { timeout: 20000 }, () => {
  it('answers an authenticated Slack "Phantom status" from the brief and never calls the model', async () => {
    expect(await slackRequest('slack-1', 'Phantom status')).toMatchObject({ status: 'accepted' });
    const reply = vi.fn(async () => 'model');
    expect(await tick({ statusBrief: async () => BRIEF, reply })).toMatchObject({ replies: 1 });
    expect(reply).not.toHaveBeenCalled();
    expect(sent.map(bodyText)).toEqual([`Leader: ${BRIEF}`]);
  });
  it('answers the desktop local-owner "status" the same way', async () => {
    expect(await request('desk-1', 'status', 'bus', 'local-owner')).toMatchObject({ status: 'accepted' });
    const reply = vi.fn(async () => 'model');
    expect(await tick({ statusBrief: async () => BRIEF, reply })).toMatchObject({ replies: 1 });
    expect(reply).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });
  it('computes the brief once for several status requests in a batch', async () => {
    await slackRequest('slack-a', 'status');
    await slackRequest('slack-b', 'Leader, sitrep');
    const statusBrief = vi.fn(async () => BRIEF);
    expect(await tick({ statusBrief, reply: async () => null })).toMatchObject({ replies: 2 });
    expect(statusBrief).toHaveBeenCalledTimes(1);
    expect(sent.map(bodyText)).toEqual([`Leader: ${BRIEF}`, `Leader: ${BRIEF}`]);
  });
  it('still uses the model for a non-status request and does not build the brief', async () => {
    await slackRequest('slack-c', 'please review the release plan');
    const statusBrief = vi.fn(async () => BRIEF);
    const reply = vi.fn(async () => 'Synthetic model answer');
    expect(await tick({ statusBrief, reply })).toMatchObject({ replies: 1 });
    expect(reply).toHaveBeenCalledOnce();
    expect(statusBrief).not.toHaveBeenCalled();
  });
  it('falls back to the model when the brief throws', async () => {
    await slackRequest('slack-d', 'Phantom status');
    const reply = vi.fn(async () => 'Synthetic model fallback');
    expect(await tick({ statusBrief: async () => { throw new Error('synthetic'); }, reply })).toMatchObject({ replies: 1 });
    expect(reply).toHaveBeenCalledOnce();
    expect(sent.map(bodyText)).toEqual(['Leader: Synthetic model fallback']);
  });
  it('falls back to the model when the brief is blank', async () => {
    await slackRequest('slack-e', 'Phantom status');
    const reply = vi.fn(async () => 'Synthetic model fallback');
    expect(await tick({ statusBrief: async () => '   \n  ', reply })).toMatchObject({ replies: 1 });
    expect(reply).toHaveBeenCalledOnce();
    expect(sent.map(bodyText)).toEqual(['Leader: Synthetic model fallback']);
  });
  it('does not duplicate delivery when the same request is replayed', async () => {
    const message = { id: 'slack-dup', from: 'mason', to: 'leader', priority: 'P0' as const, ttl: 100000, body: { text: 'Phantom status' }, channel: 'slack' as const, channel_ref: 'synthetic-slack-dup',
      sender: { agent_id: 'mason', vendor: 'fixture', human: true, team: true }, external: false };
    const sources = { configSource: configText, commsSource: 'confirmedByMason=true\n' };
    const first = await createLeaderNetwork({ ...sources, runsDir: options.runsDir, busRoot: options.busRoot, now: options.now }).ingest({ message, verifiedSender: { channel: 'slack', id: 'U0OWNER' } });
    expect(first.status).toBe('accepted');
    const second = await createLeaderNetwork({ ...sources, runsDir: options.runsDir, busRoot: options.busRoot, now: options.now }).ingest({ message, verifiedSender: { channel: 'slack', id: 'U0OWNER' } });
    expect(second.status).toBe('duplicate');
    expect(await tick({ statusBrief: async () => BRIEF, reply: async () => 'model' })).toMatchObject({ replies: 1 });
    expect(sent).toHaveLength(1);
    // A second tick has nothing pending and delivers nothing more.
    expect(await tick({ statusBrief: async () => BRIEF, reply: async () => 'model' })).toMatchObject({ replies: 0 });
    expect(sent).toHaveLength(1);
  });
  it('never answers an unverified sender, even with a working brief', async () => {
    const result = await request('slack-out', 'Phantom status', 'slack', 'U0OUTSIDER', 'outsider');
    expect(['ignored', 'refused', 'unavailable']).toContain(result.status);
    const reply = vi.fn(async () => 'model');
    const statusBrief = vi.fn(async () => BRIEF);
    expect(await tick({ statusBrief, reply })).toMatchObject({ replies: 0 });
    expect(reply).not.toHaveBeenCalled();
    expect(statusBrief).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});
