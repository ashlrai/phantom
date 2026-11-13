/**
 * RQ-PHX-STATUSOWNERPROOF281S — executable review evidence for owner PR #5312
 * (RQ-PHX-STATUSROUNDTRIPRECOVER227S, head 825a7c8737f6dab854c620ad04f683d1a73a75b9).
 * The owner suite always injects the `statusBrief` seam; this suite exercises the
 * DEFAULT path — tickLeaderNetwork's built-in dynamic `instantBrief` import. Only
 * a call-through spy wraps that one export (one-shot throw/blank overrides) and
 * the module's own `setLeaderLineDepsForTest` supplies plainly fake empty fact
 * sources with a null narrative seat. ingest/tick/receipt/reply run for real.
 * No sockets, no model calls, no live writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import type { DeliverResult, TeamIdentity } from '../src/core/agents/channel-policy.js';
import { createLeaderNetwork } from '../src/core/agents/leader-network.js';
import { tickLeaderNetwork } from '../src/core/agents/leader-network-runtime.js';
import { instantBrief, setLeaderLineDepsForTest } from '../src/core/comms/leader-line.js';

vi.mock('../src/core/comms/leader-line.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/comms/leader-line.js')>();
  return { ...mod, instantBrief: vi.fn(mod.instantBrief) };
});
const instantBriefMock = vi.mocked(instantBrief);

const CONFIG_TEXT = '[mason]\nidentities=[{channel="slack",id="U0OWNER"},{channel="bus",id="local-owner"}]\n[team]\nidentities=[{channel="slack",id="U0OWNER"},{channel="bus",id="local-owner"}]\n';
const COMMS_TEXT = 'confirmedByMason=true\n';
const LINE_NOW = Date.parse('2026-11-12T12:00:00Z');

let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
let deliverOutcome: DeliverResult;
const deliverAttempts: Array<{ identity: TeamIdentity; envelope: BusEnvelope }> = [];
const deliver = vi.fn(async (identity: TeamIdentity, envelope: BusEnvelope): Promise<DeliverResult> => {
  deliverAttempts.push({ identity, envelope });
  return deliverOutcome;
});
const modelReply = vi.fn(async (_text: string): Promise<string | null> => 'Synthetic model answer');

/** Bounded, plainly fake leader-line state: real instantBrief composes its
 * brief from these empty sources; the narrative seat returns null. */
function installLineDeps(): void {
  setLeaderLineDepsForTest({
    now: () => LINE_NOW,
    narrative: async () => null,
    isAnswered: () => true,
    driveReport: () => null,
    markDriveReportPosted: () => undefined,
    events: async () => [],
    leaderHealth: () => null,
    briefSources: {
      leader: () => null,
      cloudTasks: () => [],
      devinTasks: () => [],
      openQuestion: () => null,
      driveReport: () => null,
      holds: () => [],
      autonomy: () => ({ on: true, mode: 'balanced' }),
      comms: () => null,
      digest: {
        ledger: async () => [],
        appliedProposals: () => [],
        proposalTitle: () => null,
        cloudTasks: () => [],
        capacity: () => null,
        memos: () => [],
        // The only network-shaped source: a fixed empty GitHub window.
        fleetTruth: async (sinceMs, nowMs) => ({
          windowStartMs: sinceMs, windowEndMs: nowMs ?? LINE_NOW, merged: [],
          mergeCountState: 'ok', truncated: false, running: null, queued: null,
        }),
      },
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'leader-status-owner-281s-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => LINE_NOW };
  mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), CONFIG_TEXT, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), COMMS_TEXT, { mode: 0o600 });
  deliverOutcome = { status: 'sent', reason: 'Synthetic delivery' };
  deliverAttempts.length = 0;
  installLineDeps();
});
afterEach(() => {
  setLeaderLineDepsForTest(null);
  rmSync(root, { recursive: true, force: true });
});

async function slackRequest(id: string, text: string, channel: 'slack' | 'bus' = 'slack', identity = 'U0OWNER', senderId = 'mason') {
  return createLeaderNetwork({
    configSource: CONFIG_TEXT, commsSource: COMMS_TEXT,
    runsDir: options.runsDir, busRoot: options.busRoot, now: options.now,
  }).ingest({
    message: {
      id, from: senderId, to: 'leader', priority: 'P0', ttl: 100000, body: { text },
      channel, channel_ref: `synthetic-${id}`,
      sender: { agent_id: senderId, vendor: 'fixture', human: true, team: true }, external: false,
    },
    verifiedSender: { channel, id: identity } as TeamIdentity,
  });
}

/** The production deps shape minus `statusBrief`: the default instantBrief
 * import is what is under test. `reply` stands in for the model seat. */
const tick = () => tickLeaderNetwork({} as AshlrConfig, options, { deliver, reply: modelReply });
const bodyText = (envelope: BusEnvelope) => (envelope.body as { text: string }).text;
const sentBrief = async (): Promise<string> => {
  const result = instantBriefMock.mock.results.at(-1);
  expect(result?.type).toBe('return');
  return (await (result as { value: Promise<string> }).value);
};

describe('default status brief path (owner evidence 281s)', () => {
  it('answers an authenticated Slack status request through the real default instantBrief, no model seat', async () => {
    expect(await slackRequest('s1', 'Phantom status')).toMatchObject({ status: 'accepted' });
    expect(await tick()).toMatchObject({ replies: 1 });
    expect(modelReply).not.toHaveBeenCalled();
    expect(instantBriefMock).toHaveBeenCalledTimes(1);
    const brief = await sentBrief();
    expect(brief).toContain('Status · ');
    expect(brief).toContain('Blockers: none.');
    expect(deliverAttempts).toHaveLength(1);
    const attempt = deliverAttempts[0]!;
    expect(attempt.identity).toEqual({ channel: 'slack', id: 'U0OWNER' });
    expect(attempt.envelope.channel).toBe('slack');
    expect(attempt.envelope.channel_ref).toBe('synthetic-s1');
    expect(bodyText(attempt.envelope)).toBe(`Leader: ${brief}`);
  });

  it('computes the default brief once per tick for a batch of status requests', async () => {
    await slackRequest('s2a', 'status');
    await slackRequest('s2b', 'Leader, sitrep');
    expect(await tick()).toMatchObject({ replies: 2 });
    expect(modelReply).not.toHaveBeenCalled();
    expect(instantBriefMock).toHaveBeenCalledTimes(1);
    expect(deliverAttempts.map(a => bodyText(a.envelope))).toEqual([
      `Leader: ${await sentBrief()}`, `Leader: ${await sentBrief()}`,
    ]);
  });

  it('replays of the same request deliver once through the real reply path', async () => {
    const message = {
      id: 's3-dup', from: 'mason', to: 'leader', priority: 'P0' as const, ttl: 100000,
      body: { text: 'Phantom status' }, channel: 'slack' as const, channel_ref: 'synthetic-s3-dup',
      sender: { agent_id: 'mason', vendor: 'fixture', human: true, team: true }, external: false,
    };
    const sources = { configSource: CONFIG_TEXT, commsSource: COMMS_TEXT };
    const first = await createLeaderNetwork({ ...sources, runsDir: options.runsDir, busRoot: options.busRoot, now: options.now })
      .ingest({ message, verifiedSender: { channel: 'slack', id: 'U0OWNER' } });
    expect(first.status).toBe('accepted');
    const second = await createLeaderNetwork({ ...sources, runsDir: options.runsDir, busRoot: options.busRoot, now: options.now })
      .ingest({ message, verifiedSender: { channel: 'slack', id: 'U0OWNER' } });
    expect(second.status).toBe('duplicate');
    expect(await tick()).toMatchObject({ replies: 1 });
    expect(deliverAttempts).toHaveLength(1);
    expect(await tick()).toMatchObject({ replies: 0 });
    expect(deliverAttempts).toHaveLength(1);
    expect(instantBriefMock).toHaveBeenCalledTimes(1);
  });

  it('a throwing default brief falls back to the reply seat instead of sending brief-shaped text', async () => {
    await slackRequest('s4', 'Phantom status');
    instantBriefMock.mockRejectedValueOnce(new Error('synthetic brief failure'));
    expect(await tick()).toMatchObject({ replies: 1 });
    expect(instantBriefMock).toHaveBeenCalledTimes(1);
    expect(modelReply).toHaveBeenCalledTimes(1);
    expect(modelReply).toHaveBeenCalledWith('Phantom status');
    expect(deliverAttempts.map(a => bodyText(a.envelope))).toEqual(['Leader: Synthetic model answer']);
    expect(bodyText(deliverAttempts[0]!.envelope)).not.toContain('Status ·');
  });

  it('a blank default brief falls back the same way', async () => {
    await slackRequest('s5', 'Phantom status');
    instantBriefMock.mockResolvedValueOnce('  \n\t  ');
    expect(await tick()).toMatchObject({ replies: 1 });
    expect(modelReply).toHaveBeenCalledTimes(1);
    expect(deliverAttempts.map(a => bodyText(a.envelope))).toEqual(['Leader: Synthetic model answer']);
  });

  it('a failed transport is not counted as sent and retries honestly on the next tick', async () => {
    await slackRequest('s6', 'Phantom status');
    deliverOutcome = { status: 'drafted', reason: 'Synthetic transport refusal' };
    expect(await tick()).toMatchObject({ replies: 0 });
    expect(deliverAttempts).toHaveLength(1);
    // The reply text is retained on the route; the next tick re-attempts
    // delivery of the same text without recomputing the brief or the model.
    deliverOutcome = { status: 'sent', reason: 'Synthetic delivery' };
    expect(await tick()).toMatchObject({ replies: 1 });
    expect(deliverAttempts).toHaveLength(2);
    expect(deliverAttempts.map(a => bodyText(a.envelope))).toEqual([
      `Leader: ${await sentBrief()}`, `Leader: ${await sentBrief()}`,
    ]);
    expect(modelReply).not.toHaveBeenCalled();
    expect(instantBriefMock).toHaveBeenCalledTimes(1);
  });

  it('when both the brief and the reply seat produce nothing, nothing is sent or marked delivered', async () => {
    await slackRequest('s7', 'Phantom status');
    instantBriefMock.mockRejectedValueOnce(new Error('synthetic brief failure'));
    modelReply.mockResolvedValueOnce(null);
    expect(await tick()).toMatchObject({ replies: 0 });
    expect(deliverAttempts).toHaveLength(0);
    // The request stays pending; a later tick with a working brief still answers it.
    expect(await tick()).toMatchObject({ replies: 1 });
    expect(deliverAttempts).toHaveLength(1);
    expect(bodyText(deliverAttempts[0]!.envelope)).toBe(`Leader: ${await sentBrief()}`);
  });
});
