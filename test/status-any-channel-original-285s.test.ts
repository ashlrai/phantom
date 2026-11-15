import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { createLeaderNetwork } from '../src/core/agents/leader-network.js';
import { tickLeaderNetwork } from '../src/core/agents/leader-network-runtime.js';
import { classifyIntentByRules } from '../src/core/vision/leader-intent.js';

const configText = '[mason]\nidentities=[{channel="slack",id="U0OWNER"},{channel="bus",id="local-owner"}]\n[team]\nidentities=[{channel="slack",id="U0OWNER"},{channel="bus",id="local-owner"}]\n';
const commsText = 'confirmedByMason=true\n';
const BRIEF = 'Synthetic status brief';
let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const sent: BusEnvelope[] = [];
const deliver = vi.fn(async (_identity: unknown, envelope: BusEnvelope) => { sent.push(envelope); return { status: 'sent' as const, reason: 'Synthetic delivery' }; });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'leader-status-285s-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-13T12:00:00Z') };
  mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), commsText, { mode: 0o600 });
  sent.length = 0;
  deliver.mockClear();
  deliver.mockImplementation(async (_identity: unknown, envelope: BusEnvelope) => { sent.push(envelope); return { status: 'sent' as const, reason: 'Synthetic delivery' }; });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sources = { configSource: configText, commsSource: commsText };
const service = () => createLeaderNetwork({ ...sources, runsDir: options.runsDir, busRoot: options.busRoot, now: options.now });

async function request(id: string, text: string, channel: 'slack' | 'bus', identity: string) {
  const result = await service().ingest({
    message: { id, from: 'mason', to: 'leader', priority: 'P0', ttl: 100000, body: { text }, channel, channel_ref: `synthetic-${id}`,
      sender: { agent_id: 'mason', vendor: 'fixture', human: true, team: true }, external: false },
    verifiedSender: { channel, id: identity } });
  expect(result.status).toBe('accepted');
  return result.requestId!;
}
const slackRequest = (id: string, text: string) => request(id, text, 'slack', 'U0OWNER');
const busRequest = (id: string, text: string) => request(id, text, 'bus', 'local-owner');
const tick = (deps: Parameters<typeof tickLeaderNetwork>[2] = {}) => tickLeaderNetwork({} as AshlrConfig, options, { deliver, ...deps });
const bodyText = (envelope: BusEnvelope) => (envelope.body as { text: string }).text;

describe('status intent through the real classifier', () => {
  it.each(['Phantom status', 'phantom: status?', 'Leader, sitrep', 'LEADER status!', 'phantom /status'])('%s is status', text => {
    expect(classifyIntentByRules(text).kind).toBe('status');
  });
  it.each(['status', '/status', 'sitrep?', "what's up"])('bare %s stays status', text => {
    expect(classifyIntentByRules(text).kind).toBe('status');
  });
  it('does not treat longer action sentences as status', () => {
    expect(classifyIntentByRules('phantom status page is broken, fix it').kind).not.toBe('status');
    expect(classifyIntentByRules('phantom phantom status').kind).not.toBe('status');
    expect(classifyIntentByRules('leader, please fix the flaky deploy').kind).not.toBe('status');
  });
});

describe('model-free status brief through tickLeaderNetwork', { timeout: 20000 }, () => {
  it('answers a Slack "Phantom status" from the brief on the same channel, never calling the model', async () => {
    await slackRequest('slack-1', 'Phantom status');
    const reply = vi.fn(async () => 'model');
    expect(await tick({ statusBrief: async () => BRIEF, reply })).toMatchObject({ replies: 1 });
    expect(reply).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'slack', channel_ref: 'synthetic-slack-1', body: { text: `Leader: ${BRIEF}` } });
    expect(await service().pending()).toEqual([]);
    const outbox = readFileSync(join(options.runsDir, 'leader/MASON-OUTBOX.md'), 'utf8');
    expect(outbox.match(/\[leader-network:reply-/g)).toHaveLength(1);
  });
  it('answers the desktop local-owner bare "status" the same way', async () => {
    await busRequest('desk-1', 'status');
    const reply = vi.fn(async () => 'model');
    expect(await tick({ statusBrief: async () => BRIEF, reply })).toMatchObject({ replies: 1 });
    expect(reply).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ channel: 'bus', channel_ref: 'synthetic-desk-1', body: { text: `Leader: ${BRIEF}` } });
  });
  it('computes the brief once for several status requests in a tick', async () => {
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
    expect(sent.map(bodyText)).toEqual(['Leader: Synthetic model answer']);
  });
  it('falls back to the model when the brief throws', async () => {
    await slackRequest('slack-d', 'Phantom status');
    const reply = vi.fn(async () => 'Synthetic model fallback');
    expect(await tick({ statusBrief: async () => { throw new Error('synthetic'); }, reply })).toMatchObject({ replies: 1 });
    expect(reply).toHaveBeenCalledOnce();
    expect(sent.map(bodyText)).toEqual(['Leader: Synthetic model fallback']);
  });
  it('falls back to the model when the brief is empty', async () => {
    await slackRequest('slack-e', 'Phantom status');
    const reply = vi.fn(async () => 'Synthetic model fallback');
    expect(await tick({ statusBrief: async () => '   ', reply })).toMatchObject({ replies: 1 });
    expect(reply).toHaveBeenCalledOnce();
  });
  it('retries a saved reply without recomputing the brief or calling the model', async () => {
    await slackRequest('slack-f', 'Phantom status');
    let attempts = 0;
    deliver.mockImplementation(async (_identity: unknown, envelope: BusEnvelope) => {
      sent.push(envelope);
      return ++attempts === 1 ? { status: 'drafted' as const, reason: 'Synthetic hold' } : { status: 'sent' as const, reason: 'Synthetic delivery' };
    });
    const statusBrief = vi.fn(async () => BRIEF);
    const reply = vi.fn(async () => 'model');
    expect(await tick({ statusBrief, reply })).toMatchObject({ replies: 0 });
    expect(statusBrief).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(await tick({ statusBrief, reply })).toMatchObject({ replies: 1 });
    expect(statusBrief).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(sent.map(bodyText)).toEqual([`Leader: ${BRIEF}`, `Leader: ${BRIEF}`]);
    expect(await service().pending()).toEqual([]);
  });
  it('refuses ingress from a non-owner sender and never builds a brief', async () => {
    const ignored = await service().ingest({
      message: { id: 'slack-out', from: 'mason', to: 'leader', priority: 'P0', ttl: 100000, body: { text: 'Phantom status' }, channel: 'slack', channel_ref: 'synthetic-out',
        sender: { agent_id: 'mason', vendor: 'fixture', human: true, team: true }, external: false },
      verifiedSender: { channel: 'slack', id: 'U0OUTSIDER' } });
    expect(ignored.status).toBe('ignored');
    const statusBrief = vi.fn(async () => BRIEF);
    const reply = vi.fn(async () => 'model');
    expect(await tick({ statusBrief, reply })).toMatchObject({ replies: 0 });
    expect(statusBrief).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
