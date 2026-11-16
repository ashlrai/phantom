import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readChannelHealth,
  type ChannelHealth,
  type ChannelSource,
  type ReplyBindingEvidence,
} from '../src/core/fleet/channel-health.js';

const NOW = new Date('2026-11-13T18:00:00.000Z');
const ago = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();

const src = (over: Partial<ChannelSource> = {}): ChannelSource => ({
  configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [], ...over,
});
const bound = (over: Partial<ReplyBindingEvidence> = {}): ReplyBindingEvidence => ({
  store: 'ok', answeredAt: [], unansweredAt: [], futureDated: 0, ...over,
});
const run = (slack: ChannelSource, imessage: ChannelSource = src()) =>
  readChannelHealth({ now: () => NOW, host: 'fake-host', sources: { slack, imessage } });
const slackOf = async (slack: ChannelSource): Promise<ChannelHealth> => (await run(slack)).channels[0]!;

describe('channel health with a per-request Slack reply binding', () => {
  it('an answered request 30 min old is LIVE and verified', async () => {
    const s = await slackOf(src({
      inboundEvidence: () => ({ store: 'ok', rows: [{ at: ago(30), admission: 'posted' }] }),
      replies: () => [ago(29)],
      replyBinding: () => bound({ answeredAt: [ago(30)] }),
    }));
    expect(s.state).toBe('LIVE');
    expect(s.unansweredCount).toBe(0);
    expect(s.missing).toEqual([]);
    expect(s.proof).toEqual({
      requestCoverage: 'verified', futureDatedCount: 0, answeredCount: 1,
      durableIngress: { posted: 1, duplicate: 0, failed: 0, unverified: 0 },
    });
    expect(s.lastInboundAt).toBe(ago(30));
    expect(s.lastReplyAt).toBe(ago(29));
  });

  it('an unanswered request 30 min old is DEGRADED and unproven', async () => {
    const s = await slackOf(src({
      inboundEvidence: () => ({ store: 'ok', rows: [{ at: ago(30), admission: 'posted' }] }),
      replies: () => [ago(29)],
      replyBinding: () => bound({ unansweredAt: [ago(30)] }),
    }));
    expect(s.state).toBe('DEGRADED');
    expect(s.unansweredCount).toBe(1);
    expect(s.proof.requestCoverage).toBe('unproven');
    expect(s.proof.answeredCount).toBe(0);
    // The binding is authoritative, so the timestamp-only reason never appears.
    expect(s.missing).not.toContain('slack reply correlation unavailable');
  });

  it('one unanswered request among answered ones blocks verified', async () => {
    const s = await slackOf(src({
      inboundEvidence: () => ({ store: 'ok', rows: [{ at: ago(30) }, { at: ago(20) }] }),
      replyBinding: () => bound({ answeredAt: [ago(30)], unansweredAt: [ago(20)] }),
    }));
    expect(s).toMatchObject({ state: 'DEGRADED', unansweredCount: 1 });
    expect(s.proof).toMatchObject({ requestCoverage: 'unproven', answeredCount: 1 });
  });

  it('a fresh unanswered request inside grace stays LIVE but unproven', async () => {
    const s = await slackOf(src({
      inboundEvidence: () => ({ store: 'ok', rows: [{ at: ago(5) }] }),
      replyBinding: () => bound({ unansweredAt: [ago(5)] }),
    }));
    expect(s).toMatchObject({ state: 'LIVE', unansweredCount: 1 });
    expect(s.proof.requestCoverage).toBe('unproven');
  });

  it('requests outside the window and future-dated requests are never pending or answered', async () => {
    const future = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    const s = await slackOf(src({
      inboundEvidence: () => ({ store: 'ok', rows: [{ at: ago(90) }, { at: ago(80) }] }),
      replyBinding: () => bound({ answeredAt: [ago(90)], unansweredAt: [ago(80), future], futureDated: 1 }),
    }));
    expect(s).toMatchObject({ state: 'LIVE', unansweredCount: 0 });
    expect(s.proof).toMatchObject({ requestCoverage: 'idle', answeredCount: 0 });
  });

  it('no inbound in the window is idle, not verified', async () => {
    const s = await slackOf(src({
      inboundEvidence: () => ({ store: 'ok', rows: [] }),
      replyBinding: () => bound(),
    }));
    expect(s.state).toBe('LIVE');
    expect(s.proof).toMatchObject({ requestCoverage: 'idle', answeredCount: 0 });
  });

  it('durable ingress failure still degrades an answered request', async () => {
    const s = await slackOf(src({
      inboundEvidence: () => ({ store: 'ok', rows: [{ at: ago(30), admission: 'failed' }] }),
      replyBinding: () => bound({ answeredAt: [ago(30)] }),
    }));
    expect(s.state).toBe('DEGRADED');
    expect(s.missing).toContain('slack durable ingress failed');
  });
});

describe('channel health falls back when the reply binding is unavailable', () => {
  const base = {
    inboundEvidence: () => ({ store: 'ok' as const, rows: [{ at: ago(30) }] }),
    replies: () => [ago(29)],
  };
  const fresh = {
    inboundEvidence: () => ({ store: 'ok' as const, rows: [{ at: ago(5) }] }),
  };

  for (const [label, binding] of [
    ['throws', () => { throw new Error('EACCES /secret/path'); }],
    ['is unreadable', () => bound({ store: 'unreadable', answeredAt: [ago(30)] })],
    ['is missing', () => bound({ store: 'missing', answeredAt: [ago(30)] })],
  ] as const) {
    it(`binding ${label}: old result plus the unreadable reason, never verified`, async () => {
      for (const over of [base, fresh, {}]) {
        const before = await slackOf(src(over));
        const after = await slackOf(src({ ...over, replyBinding: binding }));
        expect(after).toEqual({ ...before, missing: [...before.missing, 'slack reply binding unreadable'] });
        expect(after.proof.requestCoverage).not.toBe('verified');
        expect(after.proof.answeredCount).toBeUndefined();
        expect(JSON.stringify(after)).not.toContain('/secret/path');
      }
      const degraded = await slackOf(src({ ...base, replyBinding: binding }));
      expect(degraded).toMatchObject({ state: 'DEGRADED', unansweredCount: 1 });
      expect(degraded.missing).toEqual(['slack reply correlation unavailable', 'slack reply binding unreadable']);
    });
  }

  it('a source without replyBinding (iMessage shape) keeps timestamp-only output exactly', async () => {
    const r = await run(src(), src({ inbound: () => [ago(30)], replies: () => [ago(29)] }));
    expect(r.channels[1]).toEqual({
      channel: 'imessage', configured: true, processAlive: true, runtimeHost: 'fake-host',
      lastInboundAt: ago(30), lastReplyAt: ago(29), unansweredCount: 1,
      proof: { requestCoverage: 'unproven', futureDatedCount: 0 },
      state: 'DEGRADED', missing: ['imessage reply correlation unavailable'], asOf: NOW.toISOString(),
    });
    const idle = await run(src(), src());
    expect(idle.channels[1]).toMatchObject({
      state: 'LIVE', unansweredCount: 0, missing: [],
      proof: { requestCoverage: 'idle', futureDatedCount: 0 },
    });
    expect(idle.channels[1]!.proof).not.toHaveProperty('answeredCount');
  });
});

// ---------------------------------------------------------------------------
// Default Slack source: real journal + send-receipt readers under a scratch
// HOME/ASHLR_HOME; a fake process satisfies the pgrep liveness probe.
// ---------------------------------------------------------------------------

const SLACK_TOML = `[mason]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[team]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0FAKETEAM"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="C0FAKELEADER"\n`;

const CH = 'C0FAKELEADER';
const request = (at: string, messageTs: string, threadTs = messageTs) =>
  ({ at, decision: 'ingested', eventId: `ev-${messageTs}`, channelId: CH, authorId: 'U0FAKEOWNER', messageTs, threadTs, bus: 'posted' });

function fakeProcess(argv0: string): ChildProcess {
  return spawn('bash', ['-c', `exec -a "${argv0}" sleep 30`], { stdio: 'ignore' });
}

async function withSlackStores(
  journalRows: object[],
  messages: Record<string, object> | null,
  fn: (s: ChannelHealth) => void,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'ch-binding-338-'));
  const runs = join(home, 'runs');
  const ash = join(home, '.ashlr');
  const saved = { HOME: process.env['HOME'], ASHLR_HOME: process.env['ASHLR_HOME'] };
  const procs: ChildProcess[] = [];
  try {
    process.env['HOME'] = home;
    process.env['ASHLR_HOME'] = ash;
    mkdirSync(join(ash, 'fleet', 'slack-transport'), { recursive: true });
    mkdirSync(join(runs, 'slack-bridge'), { recursive: true });
    writeFileSync(join(ash, 'agent-network.toml'), SLACK_TOML, { mode: 0o600 });
    writeFileSync(join(runs, 'slack-bridge', 'journal.jsonl'),
      journalRows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    if (messages !== null) {
      writeFileSync(join(ash, 'fleet', 'slack-transport', 'messages.json'),
        JSON.stringify({ version: 1, messages }), { mode: 0o600 });
    }
    procs.push(fakeProcess('channels slack run'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const report = await readChannelHealth({ now: () => NOW, host: 'fake-host', runsDir: runs });
    fn(report.channels.find((c) => c.channel === 'slack')!);
  } finally {
    for (const p of procs) p.kill('SIGKILL');
    if (saved.HOME === undefined) delete process.env['HOME']; else process.env['HOME'] = saved.HOME;
    if (saved.ASHLR_HOME === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = saved.ASHLR_HOME;
    rmSync(home, { recursive: true, force: true });
  }
}

describe('channel health default Slack reply binding', () => {
  it('a same-thread sent receipt verifies the request', async () => {
    await withSlackStores(
      [request(ago(30), '1700000000.000100')],
      { m1: { channel: CH, thread: '1700000000.000100', state: 'sent', ts: '1700000000.000200' } },
      (s) => {
        expect(s).toMatchObject({ configured: true, processAlive: true, state: 'LIVE', unansweredCount: 0, missing: [] });
        expect(s.proof).toEqual({
          requestCoverage: 'verified', futureDatedCount: 0, answeredCount: 1,
          durableIngress: { posted: 1, duplicate: 0, failed: 0, unverified: 0 },
        });
      },
    );
  }, 30_000);

  it('attempted and top-level sends never answer a request', async () => {
    await withSlackStores(
      [
        request(ago(30), '1700000000.000100'),
        request(ago(31), '1700000100.000100'),
        request(ago(32), '1700000200.000100'),
      ],
      {
        // Thread answer for the first request.
        m1: { channel: CH, thread: '1700000000.000100', state: 'sent', ts: '1700000000.000200' },
        // Only an attempt (never confirmed) in the second request's thread.
        m2: { channel: CH, thread: '1700000100.000100', state: 'attempted' },
        // A top-level send after the third request, outside its thread.
        m3: { channel: CH, state: 'sent', ts: '1700000200.000200' },
      },
      (s) => {
        expect(s.state).toBe('DEGRADED');
        expect(s.unansweredCount).toBe(2);
        expect(s.proof).toMatchObject({ requestCoverage: 'unproven', answeredCount: 1 });
        expect(s.missing).not.toContain('slack reply correlation unavailable');
        expect(JSON.stringify(s)).not.toMatch(/C0FAKELEADER|U0FAKEOWNER|1700000/);
      },
    );
  }, 30_000);

  it('id-less legacy rows can never be counted as answered', async () => {
    await withSlackStores(
      [{ at: ago(30), decision: 'ingested', eventId: 'ev-legacy' }],
      { m1: { channel: CH, thread: '1700000000.000100', state: 'sent', ts: '1700000000.000200' } },
      (s) => {
        expect(s).toMatchObject({ state: 'DEGRADED', unansweredCount: 1 });
        expect(s.proof).toMatchObject({ requestCoverage: 'unproven', answeredCount: 0 });
      },
    );
  }, 30_000);

  it('a missing send store leaves the request unanswered, not unreadable', async () => {
    await withSlackStores([request(ago(30), '1700000000.000100')], null, (s) => {
      expect(s).toMatchObject({ state: 'DEGRADED', unansweredCount: 1 });
      expect(s.proof).toMatchObject({ requestCoverage: 'unproven', answeredCount: 0 });
      expect(s.missing).not.toContain('slack reply binding unreadable');
    });
  }, 30_000);
});
