import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readChannelHealth,
  type ChannelSource,
  type InboundEvidence,
} from '../src/core/fleet/channel-health.js';

const NOW = new Date('2026-11-13T18:00:00.000Z');
const ago = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();
const ahead = (min: number): string => new Date(NOW.getTime() + min * 60_000).toISOString();

const src = (over: Partial<ChannelSource> = {}): ChannelSource => ({
  configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [], ...over,
});
const run = (slack: ChannelSource) =>
  readChannelHealth({ now: () => NOW, host: 'fake-host', sources: { slack, imessage: src() } });
const slackOf = async (slack: ChannelSource) => (await run(slack)).channels[0]!;

afterEach(() => vi.restoreAllMocks());

describe('channel health durable ingress evidence', () => {
  it('posted and duplicate admissions stay LIVE-eligible and count distinctly', async () => {
    const posted = await slackOf(src({
      inboundEvidence: () => ({ store: 'ok', rows: [{ at: ago(5), admission: 'posted' }] }),
    }));
    expect(posted).toMatchObject({ state: 'LIVE', unansweredCount: 1 });
    expect(posted.proof.durableIngress).toEqual({ posted: 1, duplicate: 0, failed: 0, unverified: 0 });

    const dup = await slackOf(src({
      inboundEvidence: () => ({ store: 'ok', rows: [{ at: ago(5), admission: 'duplicate' }] }),
    }));
    expect(dup).toMatchObject({ state: 'LIVE' });
    expect(dup.proof.durableIngress).toEqual({ posted: 0, duplicate: 1, failed: 0, unverified: 0 });
  });

  it('a failed bus post is DEGRADED with an explicit sanitized reason, never LIVE', async () => {
    const s = await slackOf(src({
      inboundEvidence: () => ({ store: 'ok', rows: [{ at: ago(5), admission: 'failed' }] }),
    }));
    expect(s.state).toBe('DEGRADED');
    expect(s.missing).toContain('slack durable ingress failed');
    expect(s.unansweredCount).toBe(1);
    expect(s.proof.durableIngress).toEqual({ posted: 0, duplicate: 0, failed: 1, unverified: 0 });
    expect(s.proof.requestCoverage).toBe('unproven');
  });

  it('a later unrelated reply cannot clear a failed durable admission', async () => {
    const s = await slackOf(src({
      inboundEvidence: () => ({
        store: 'ok',
        rows: [{ at: ago(8), admission: 'posted' }, { at: ago(6), admission: 'failed' }],
      }),
      replies: () => [ago(5)],
    }));
    expect(s.state).toBe('DEGRADED');
    expect(s.missing).toContain('slack durable ingress failed');
    expect(s.missing).toContain('slack reply correlation unavailable');
    expect(s.proof.durableIngress).toMatchObject({ posted: 1, failed: 1 });
  });

  it('an expired-window failure does not block LIVE', async () => {
    const s = await slackOf(src({
      inboundEvidence: () => ({ store: 'ok', rows: [{ at: ago(120), admission: 'failed' }] }),
    }));
    expect(s).toMatchObject({ state: 'LIVE', unansweredCount: 0 });
    expect(s.proof.durableIngress).toEqual({ posted: 0, duplicate: 0, failed: 0, unverified: 0 });
  });

  it('a future-dated failure is rejected as future-dated evidence, not a durable failure', async () => {
    const s = await slackOf(src({
      inboundEvidence: () => ({ store: 'ok', rows: [{ at: ahead(30), admission: 'failed' }] }),
    }));
    expect(s.state).toBe('UNKNOWN');
    expect(s.missing).toContain('slack future-dated receipt ignored');
    expect(s.missing).not.toContain('slack durable ingress failed');
    expect(s.proof.futureDatedCount).toBe(1);
    expect(s.proof.durableIngress).toEqual({ posted: 0, duplicate: 0, failed: 0, unverified: 0 });
  });

  it('legacy rows without a bus outcome are unverified, never counted as admitted', async () => {
    const s = await slackOf(src({
      inboundEvidence: () => ({ store: 'ok', rows: [{ at: ago(5) }] }),
    }));
    expect(s.state).toBe('LIVE');
    expect(s.proof.durableIngress).toEqual({ posted: 0, duplicate: 0, failed: 0, unverified: 1 });
  });

  it('a missing or unreadable observation store can never certify an idle healthy path', async () => {
    const missing = await slackOf(src({ inboundEvidence: (): InboundEvidence => ({ store: 'missing', rows: [] }) }));
    expect(missing).toMatchObject({ state: 'UNKNOWN', unansweredCount: 0 });
    expect(missing.missing).toContain('slack inbound journal missing');
    expect(missing.proof.durableIngress).toBeUndefined();

    const unreadable = await slackOf(src({ inboundEvidence: (): InboundEvidence => ({ store: 'unreadable', rows: [] }) }));
    expect(unreadable.state).toBe('UNKNOWN');
    expect(unreadable.missing).toContain('slack receipt source unreadable');
  });

  it('sources without inboundEvidence keep honest unknown coverage', async () => {
    const s = await slackOf(src({ inbound: () => [ago(5)] }));
    expect(s.state).toBe('LIVE');
    expect(s.proof.durableIngress).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Default Slack evidence wiring against a real scratch journal file. Fake
// processes satisfy the pgrep liveness probes; every file lives under a scratch
// HOME. iMessage stays unconfigured -- only the slack channel is asserted.
// ---------------------------------------------------------------------------

const SLACK_TOML = `[mason]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[team]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0FAKETEAM"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0FAKELEADER"\n`;

function fakeProcess(argv0: string): ChildProcess {
  return spawn('bash', ['-c', `exec -a "${argv0}" sleep 30`], { stdio: 'ignore' });
}

async function withSlackJournal(journal: string | null, fn: (runs: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'ch-ingress-322s-'));
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
    if (journal !== null) writeFileSync(join(runs, 'slack-bridge', 'journal.jsonl'), journal, { mode: 0o600 });
    procs.push(fakeProcess('channels slack run'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fn(runs);
  } finally {
    for (const p of procs) p.kill('SIGKILL');
    if (saved.HOME === undefined) delete process.env['HOME']; else process.env['HOME'] = saved.HOME;
    if (saved.ASHLR_HOME === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = saved.ASHLR_HOME;
    rmSync(home, { recursive: true, force: true });
  }
}

const slackChannel = async (runs: string) =>
  (await readChannelHealth({ now: () => NOW, host: 'fake-host', runsDir: runs })).channels.find((c) => c.channel === 'slack')!;

describe('channel health default Slack journal wiring', () => {
  it('a journal bus=failed row degrades a running configured bridge', async () => {
    await withSlackJournal(
      `${JSON.stringify({ at: ago(5), decision: 'ingested', eventId: 'ev-fail', bus: 'failed' })}\n`,
      async (runs) => {
        const s = await slackChannel(runs);
        expect(s.configured).toBe(true);
        expect(s.processAlive).toBe(true);
        expect(s.state).toBe('DEGRADED');
        expect(s.missing).toContain('slack durable ingress failed');
        expect(s.proof.durableIngress).toEqual({ posted: 0, duplicate: 0, failed: 1, unverified: 0 });
      },
    );
  }, 30_000);

  it('a missing journal cannot certify an idle healthy request path', async () => {
    await withSlackJournal(null, async (runs) => {
      const s = await slackChannel(runs);
      expect(s.configured).toBe(true);
      expect(s.processAlive).toBe(true);
      expect(s.state).toBe('UNKNOWN');
      expect(s.missing).toContain('slack inbound journal missing');
    });
  }, 30_000);

  it('a malformed journal line degrades coverage to unreadable', async () => {
    await withSlackJournal(
      `${JSON.stringify({ at: ago(5), decision: 'ingested', bus: 'posted' })}\n{not json\n`,
      async (runs) => {
        const s = await slackChannel(runs);
        expect(s.state).toBe('UNKNOWN');
        expect(s.missing).toContain('slack receipt source unreadable');
        expect(s.proof.durableIngress).toBeUndefined();
      },
    );
  }, 30_000);

  it('legacy journal rows without bus stay unverified and LIVE-eligible inside grace', async () => {
    await withSlackJournal(
      `${JSON.stringify({ at: ago(5), decision: 'ingested', eventId: 'ev-legacy' })}\n`,
      async (runs) => {
        const s = await slackChannel(runs);
        expect(s.state).toBe('LIVE');
        expect(s.proof.durableIngress).toEqual({ posted: 0, duplicate: 0, failed: 0, unverified: 1 });
      },
    );
  }, 30_000);

  it('journal metadata (author ids, event ids) never reaches the report', async () => {
    await withSlackJournal(
      `${JSON.stringify({ at: ago(5), decision: 'ingested', envelopeId: 'env-secret-1', eventId: 'ev-secret-2', channelId: 'C0SECRET', authorId: 'U0SECRET', bus: 'failed' })}\n`,
      async (runs) => {
        const report = await readChannelHealth({ now: () => NOW, host: 'fake-host', runsDir: runs });
        const text = JSON.stringify(report);
        for (const leaked of ['env-secret-1', 'ev-secret-2', 'C0SECRET', 'U0SECRET']) {
          expect(text).not.toContain(leaked);
        }
      },
    );
  }, 30_000);
});
