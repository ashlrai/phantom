import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import type { DeliverResult, TeamIdentity } from '../src/core/agents/channel-policy.js';
import { createLeaderNetwork } from '../src/core/agents/leader-network.js';
import { tickLeaderNetwork } from '../src/core/agents/leader-network-runtime.js';

const configText = '[mason]\nidentities=[{channel="slack",id="U0OWNER"},{channel="bus",id="local-owner"}]\n[team]\nidentities=[{channel="slack",id="U0OWNER"},{channel="bus",id="local-owner"}]\n';
const commsText = 'confirmedByMason=true\n';
const BRIEF = 'Synthetic restart brief';
let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const sources = { configSource: configText, commsSource: commsText };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'leader-restart-479s-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-16T12:00:00Z') };
  mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), commsText, { mode: 0o600 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const service = () => createLeaderNetwork({ ...sources, runsDir: options.runsDir, busRoot: options.busRoot, now: options.now });
const tick = (deps: Parameters<typeof tickLeaderNetwork>[2]) => tickLeaderNetwork({} as AshlrConfig, options, deps);
const outbox = () => readFileSync(join(options.runsDir, 'leader/MASON-OUTBOX.md'), 'utf8');

async function statusRequest(id: string, channel: 'slack' | 'bus', identity: string) {
  const result = await service().ingest({
    message: { id, from: 'mason', to: 'leader', priority: 'P0', ttl: 100000, body: { text: 'Phantom status' }, channel, channel_ref: `synthetic-${id}`,
      sender: { agent_id: 'mason', vendor: 'fixture', human: true, team: true }, external: false },
    verifiedSender: { channel, id: identity } });
  expect(result.status).toBe('accepted');
  return result.requestId!;
}

describe('channel-independent status replies across a Leader restart', { timeout: 20000 }, () => {
  it('replays only the held channel reply from durable state without a model or brief recompute', async () => {
    const slackId = await statusRequest('slack-479s', 'slack', 'U0OWNER');
    const busId = await statusRequest('bus-479s', 'bus', 'local-owner');
    const sent: BusEnvelope[] = [];
    const holdSlack = vi.fn(async (identity: TeamIdentity, envelope: BusEnvelope): Promise<DeliverResult> => {
      sent.push(envelope);
      return identity.channel === 'slack' ? { status: 'drafted', reason: 'Synthetic hold' } : { status: 'sent', reason: 'Synthetic delivery' };
    });
    const brief1 = vi.fn(async () => BRIEF);
    const model1 = vi.fn(async () => 'model');
    expect(await tick({ deliver: holdSlack, statusBrief: brief1, reply: model1 })).toMatchObject({ replies: 1 });
    expect(brief1).toHaveBeenCalledTimes(1);
    expect(model1).not.toHaveBeenCalled();
    const on = (channel: string) => sent.find(e => e.channel === channel)!;
    expect(on('slack')).toMatchObject({ channel_ref: 'synthetic-slack-479s', body: { text: `Leader: ${BRIEF}` } });
    expect(on('bus')).toMatchObject({ channel_ref: 'synthetic-bus-479s', body: { text: `Leader: ${BRIEF}` } });
    const pending = await service().pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requestId: slackId, replyText: BRIEF });
    expect(pending[0]!.envelope).toMatchObject({ channel: 'slack', channel_ref: 'synthetic-slack-479s' });

    // Restart: fresh service, options view and transports over the same durable roots.
    const sent2: BusEnvelope[] = [];
    const deliver2 = vi.fn(async (_identity: TeamIdentity, envelope: BusEnvelope): Promise<DeliverResult> => {
      sent2.push(envelope);
      return { status: 'sent', reason: 'Synthetic delivery' };
    });
    const brief2 = vi.fn(async () => BRIEF);
    const model2 = vi.fn(async () => 'model');
    expect(await tick({ deliver: deliver2, statusBrief: brief2, reply: model2 })).toMatchObject({ replies: 1 });
    expect(deliver2).toHaveBeenCalledTimes(1);
    expect(sent2[0]).toMatchObject({ channel: 'slack', channel_ref: 'synthetic-slack-479s', body: { text: `Leader: ${BRIEF}` } });
    expect(brief2).not.toHaveBeenCalled();
    expect(model2).not.toHaveBeenCalled();
    expect(await service().pending()).toEqual([]);

    const text = outbox();
    expect(text.match(/\[leader-network:reply-/g)).toHaveLength(2);
    expect(text).toContain(`[leader-network:reply-${slackId}]`);
    expect(text).toContain(`[leader-network:reply-${busId}]`);

    const deliver3 = vi.fn(async (): Promise<DeliverResult> => ({ status: 'sent', reason: 'Synthetic delivery' }));
    expect(await tick({ deliver: deliver3, statusBrief: brief2, reply: model2 })).toMatchObject({ replies: 0 });
    expect(deliver3).not.toHaveBeenCalled();
    expect(await service().pending()).toEqual([]);
  });
});
