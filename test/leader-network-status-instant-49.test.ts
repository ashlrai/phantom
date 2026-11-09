import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { createLeaderNetwork } from '../src/core/agents/leader-network.js';
import { tickLeaderNetwork } from '../src/core/agents/leader-network-runtime.js';

const configText = '[mason]\nidentities=[{channel="slack",id="U0OWNER"},{channel="bus",id="local-owner"}]\n[team]\nidentities=[{channel="slack",id="U0OWNER"},{channel="bus",id="local-owner"}]\n';
const BRIEF = 'Synthetic status brief';
let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const sent: BusEnvelope[] = [];
const deliver = vi.fn(async (_identity: unknown, envelope: BusEnvelope) => { sent.push(envelope); return { status: 'sent' as const, reason: 'Synthetic delivery' }; });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'leader-status-49-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-09T12:00:00Z') };
  mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  sent.length = 0;
  deliver.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function request(id: string, text: string, channel: 'slack' | 'bus', identity: string) {
  const sources = { configSource: configText, commsSource: 'confirmedByMason=true\n' };
  const result = await createLeaderNetwork({ ...sources, runsDir: options.runsDir, busRoot: options.busRoot, now: options.now }).ingest({
    message: { id, from: 'mason', to: 'leader', priority: 'P0', ttl: 100000, body: { text }, channel, channel_ref: `synthetic-${id}`,
      sender: { agent_id: 'mason', vendor: 'fixture', human: true, team: true }, external: false },
    verifiedSender: { channel, id: identity } });
  expect(result.status).toBe('accepted');
}
const slackRequest = (id: string, text: string) => request(id, text, 'slack', 'U0OWNER');
const tick = (deps: Parameters<typeof tickLeaderNetwork>[2]) => tickLeaderNetwork({} as AshlrConfig, options, { deliver, ...deps });
const bodyText = (envelope: BusEnvelope) => (envelope.body as { text: string }).text;

describe('instant status brief without a model', { timeout: 20000 }, () => {
  it('answers a Slack "Phantom status" from the brief and never calls the model', async () => {
    await slackRequest('slack-1', 'Phantom status');
    const reply = vi.fn(async () => 'model');
    expect(await tick({ statusBrief: async () => BRIEF, reply })).toMatchObject({ replies: 1 });
    expect(reply).not.toHaveBeenCalled();
    expect(sent.map(bodyText)).toEqual([`Leader: ${BRIEF}`]);
  });
  it('answers the desktop local-owner "status" the same way', async () => {
    await request('desk-1', 'status', 'bus', 'local-owner');
    const reply = vi.fn(async () => 'model');
    expect(await tick({ statusBrief: async () => BRIEF, reply })).toMatchObject({ replies: 1 });
    expect(reply).not.toHaveBeenCalled();
  });
  it('computes the brief once for several status requests in a batch', async () => {
    await slackRequest('slack-a', 'status');
    await slackRequest('slack-b', 'Leader, sitrep');
    const statusBrief = vi.fn(async () => BRIEF);
    expect(await tick({ statusBrief, reply: async () => null })).toMatchObject({ replies: 2 });
    expect(statusBrief).toHaveBeenCalledTimes(1);
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
});
