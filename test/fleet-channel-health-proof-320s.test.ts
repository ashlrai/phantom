import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const NOW = new Date('2026-11-13T18:00:00.000Z');
const ago = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();
const ahead = (min: number): string => new Date(NOW.getTime() + min * 60_000).toISOString();
const src = (over: Partial<ChannelSource> = {}): ChannelSource => ({
  configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [], ...over,
});
const run = (slack: ChannelSource, imessage: ChannelSource = src()) =>
  readChannelHealth({ now: () => NOW, host: 'fake-host', sources: { slack, imessage } });

afterEach(() => vi.restoreAllMocks());

describe('channel health proof semantics', () => {
  it('two distinct inbound observations are not cleared by one later unrelated reply', async () => {
    const r = await run(src({ inbound: () => [ago(8), ago(6)], replies: () => [ago(5)] }));
    const s = r.channels[0]!;
    expect(s.state).toBe('UNKNOWN');
    expect(s.unansweredCount).toBe(2);
    expect(s.missing).toContain('slack reply correlation unavailable');
    expect(s.proof).toEqual({ requestCoverage: 'unproven', futureDatedCount: 0 });
    expect(s.lastInboundAt).toBe(ago(6));
    expect(s.lastReplyAt).toBe(ago(5));
  });

  it('overdue uncorrelated traffic remains DEGRADED with the pending count retained', async () => {
    const r = await run(src({ inbound: () => [ago(20)], replies: () => [ago(15)] }));
    const s = r.channels[0]!;
    expect(s.state).toBe('DEGRADED');
    expect(s.unansweredCount).toBe(1);
    expect(s.missing).toContain('slack reply correlation unavailable');
    expect(s.proof.requestCoverage).toBe('unproven');
  });

  it('idle LIVE proves process health only and says so in proof metadata', async () => {
    const empty = await run(src());
    expect(empty.channels[0]).toMatchObject({ state: 'LIVE', unansweredCount: 0, proof: { requestCoverage: 'idle', futureDatedCount: 0 } });
    const staleOnly = await run(src({ inbound: () => [ago(120)], replies: () => [ago(90)] }));
    expect(staleOnly.channels[0]).toMatchObject({ state: 'LIVE', unansweredCount: 0, proof: { requestCoverage: 'idle' } });
  });

  it('a future-dated reply cannot clear a legitimate pending inbound', async () => {
    const r = await run(src({ inbound: () => [ago(5)], replies: () => [ahead(60)] }));
    const s = r.channels[0]!;
    expect(s.state).toBe('UNKNOWN');
    expect(s.unansweredCount).toBe(1);
    expect(s.missing).toContain('slack future-dated receipt ignored');
    expect(s.proof.futureDatedCount).toBe(1);
    expect(s.lastReplyAt).toBeNull();
  });

  it('a future-dated inbound is not counted as a current request', async () => {
    const r = await run(src({ inbound: () => [ahead(30)], replies: () => [ago(5)] }));
    const s = r.channels[0]!;
    expect(s.unansweredCount).toBe(0);
    expect(s.state).toBe('UNKNOWN');
    expect(s.missing).toContain('slack future-dated receipt ignored');
    expect(s.proof).toEqual({ requestCoverage: 'idle', futureDatedCount: 1 });
  });

  it('blocked config/process precedence and unreadable sources stay honest', async () => {
    const r = await run(
      src({ processAlive: () => false, inbound: () => [ago(5)], replies: () => [ago(4)] }),
      src({ inbound: () => { throw new Error('EACCES /secret/path'); } }),
    );
    expect(r.channels[0]).toMatchObject({ state: 'BLOCKED', missing: ['slack bridge process not running'] });
    expect(r.channels[1]).toMatchObject({ state: 'UNKNOWN', missing: ['imessage receipt source unreadable'] });
    expect(JSON.stringify(r)).not.toContain('/secret/path');
  });
});

// ---------------------------------------------------------------------------
// Default source readers against synthetic temporary stores. Fake processes
// satisfy the pgrep liveness probes; every file lives under a scratch HOME.
// ---------------------------------------------------------------------------

const SLACK_TOML = `[mason]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[team]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0FAKETEAM"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0FAKELEADER"\n`;

function fakeProcess(argv0: string): ChildProcess {
  return spawn('bash', ['-c', `exec -a "${argv0}" sleep 30`], { stdio: 'ignore' });
}

describe('channel health default readers', () => {
  it('synthetic receipt stores cannot be cleared by one later unrelated reply', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ch-proof-320s-'));
    const runs = join(home, 'runs');
    const ash = join(home, '.ashlr');
    const saved = { HOME: process.env['HOME'], ASHLR_HOME: process.env['ASHLR_HOME'] };
    const procs: ChildProcess[] = [];
    try {
      process.env['HOME'] = home;
      process.env['ASHLR_HOME'] = ash;
      mkdirSync(join(ash, 'fleet', 'slack-transport'), { recursive: true });
      mkdirSync(join(runs, 'slack-bridge'), { recursive: true });
      mkdirSync(join(runs, 'imessage'), { recursive: true });
      writeFileSync(join(ash, 'agent-network.toml'), SLACK_TOML, { mode: 0o600 });
      writeFileSync(join(ash, 'config.json'), JSON.stringify({ comms: { enabled: true, imessageHandle: '+15550001111' } }), { mode: 0o600 });
      // Slack: two ingested inbound observations, one later unrelated sent receipt.
      const journal = [ago(8), ago(6)].map((at, i) => JSON.stringify({ at, decision: 'ingested', eventId: `ev-${i}` })).join('\n') + '\n';
      writeFileSync(join(runs, 'slack-bridge', 'journal.jsonl'), journal, { mode: 0o600 });
      const replySec = String(Math.floor((NOW.getTime() - 5 * 60_000) / 1000));
      writeFileSync(join(ash, 'fleet', 'slack-transport', 'messages.json'),
        JSON.stringify({ messages: { m1: { state: 'sent', ts: `${replySec}.000001`, expiresAt: NOW.getTime() + 86_400_000 } } }), { mode: 0o600 });
      // iMessage: two accepted inbound rows, one later last-send receipt.
      const acks = [ago(8), ago(6)].map((at, i) => JSON.stringify({ at, rowid: i + 1, status: 'accepted' })).join('\n') + '\n';
      writeFileSync(join(runs, 'imessage', 'acks.jsonl'), acks, { mode: 0o600 });
      writeFileSync(join(runs, 'imessage', 'last-send.json'), JSON.stringify({ version: 1, at: ago(5), ok: true }), { mode: 0o600 });
      procs.push(fakeProcess('channels slack run'), fakeProcess('imessage poll'));
      await new Promise((resolve) => setTimeout(resolve, 300));

      const report = await readChannelHealth({ now: () => NOW, host: 'fake-host', runsDir: runs });
      const slack = report.channels.find((c) => c.channel === 'slack')!;
      const imessage = report.channels.find((c) => c.channel === 'imessage')!;
      for (const c of [slack, imessage]) {
        expect(c.configured).toBe(true);
        expect(c.processAlive).toBe(true);
        expect(c.state).toBe('UNKNOWN');
        expect(c.unansweredCount).toBe(2);
        expect(c.missing).toContain(`${c.channel} reply correlation unavailable`);
        expect(c.proof).toEqual({ requestCoverage: 'unproven', futureDatedCount: 0 });
        expect(c.lastInboundAt).toBe(ago(6));
      }
      expect(slack.lastReplyAt).toBe(new Date(NOW.getTime() - 5 * 60_000).toISOString());
      expect(imessage.lastReplyAt).toBe(ago(5));
    } finally {
      for (const p of procs) p.kill('SIGKILL');
      if (saved.HOME === undefined) delete process.env['HOME']; else process.env['HOME'] = saved.HOME;
      if (saved.ASHLR_HOME === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = saved.ASHLR_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
