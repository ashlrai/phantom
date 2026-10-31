/**
 * 3.14 — the Telegram drain against the REAL Leader thread
 * (src/core/vision/leader-thread.ts), not a fake: a memo written to disk is
 * synced into the thread, drained to Telegram exactly once (memo summary +
 * its question, with buttons), and its delivery state is recorded as `sent`.
 *
 * No network (fake Bot API transport), no model (nothing here asks the Leader
 * to think), tmp HOME.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setTelegramSendClockForTests, setTelegramTransportForTests, pollTelegramUpdates, readTelegramHealth } from '../src/core/integrations/telegram.js';
import { runCommsCycle } from '../src/core/comms/dispatch.js';
import { lookupTelegramMessage } from '../src/core/comms/telegram-thread-map.js';
import { writeLeaderMemo } from '../src/core/vision/leader-memo.js';
import { listThread, postLeaderMessage } from '../src/core/vision/leader-thread.js';
import type { LeaderMemo } from '../src/core/vision/leader-types.js';
import type { AshlrConfig } from '../src/core/types.js';

const calls: { method: string; body: Record<string, unknown> }[] = [];
let nextId = 5000;
let home = '';
const savedHome = process.env['HOME'];

const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token-real', chatId: '7' } } } as AshlrConfig;
const fast = { sendGapMs: 0, sleep: async () => {} };
const sends = () => calls.filter((c) => c.method === 'sendMessage');

function memo(): LeaderMemo {
  const at = new Date(Date.now() - 3_600_000);
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const id = `lm-${stamp}-abcdef`;
  return {
    v: 1, id, at: at.toISOString(), status: 'ok', statusReason: null, trigger: 'schedule', dryRun: false,
    seatId: 's', model: 'm', evidenceDigest: 'd',
    bottleneck: { statement: 'Reviews <slow>', metric: null, evidence: [] },
    move: { statement: 'Merge green PRs first', why: 'w', expectedDelta: null },
    killList: [], goals: [], priorityChanges: [], standards: [], critiques: [], seatPlan: [], hypotheses: [],
    questionsForMason: ['Keep codex lanes off this week?'],
    actions: [],
  };
}

let telegramNow = 0;

beforeEach(() => {
  telegramNow = 0;
  // Exercise actual-attempt pacing with a virtual monotonic clock, not a
  // fake-transport bypass or larger timeout.
  setTelegramSendClockForTests({
    now: () => telegramNow,
    sleep: async (ms) => { telegramNow += ms; },
  });
  home = mkdtempSync(join(tmpdir(), 'ashlr-tg314-real-'));
  process.env['HOME'] = home;
  calls.length = 0;
  setTelegramTransportForTests(async (method, body) => {
    calls.push({ method, body });
    if (method === 'getUpdates') return { ok: true, result: [] };
    if (method === 'sendMessage') return { ok: true, result: { message_id: nextId++ } };
    return { ok: true, result: true };
  });
});

afterEach(() => {
  setTelegramTransportForTests(null);
  setTelegramSendClockForTests(null);
  process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('Telegram drain × real Leader thread', () => {
  it('delivers a synced memo and its question once, escaped, with buttons; state becomes sent', async () => {
    const m = memo();
    writeLeaderMemo(m);

    const first = await runCommsCycle(cfg, fast);
    expect(first.sent).toBe(2);
    const [memoSend, questionSend] = sends();
    expect(String(memoSend!.body['text'])).toMatch(/^Leader memo\n/);
    expect(String(memoSend!.body['text'])).not.toContain(m.id);
    expect(String(memoSend!.body['text'])).toContain('Reviews &lt;slow&gt;');
    expect(JSON.stringify(memoSend!.body['reply_markup'])).toContain('lt:d:');
    expect(String(questionSend!.body['text'])).toContain('Keep codex lanes off this week?');
    expect(lookupTelegramMessage(nextId - 2)).toMatchObject({ kind: 'memo', memoId: m.id });
    expect(lookupTelegramMessage(nextId - 1)).toMatchObject({ kind: 'question', questionId: `${m.id}:0` });

    const thread = listThread();
    const leaderMsgs = thread.filter((x) => x.memoId === m.id);
    expect(leaderMsgs.length).toBe(2);
    for (const x of leaderMsgs) expect(x.delivery?.telegram).toBe('sent');

    // Exactly once: the next cycle has nothing to send.
    calls.length = 0;
    const second = await runCommsCycle(cfg, fast);
    expect(second.sent).toBe(0);
    expect(sends()).toHaveLength(0);
  });

  it('a proactive Leader update posted to the thread is drained and marked sent', async () => {
    const msg = postLeaderMessage({ channel: 'system', kind: 'update', text: 'Seat grok reset — lanes resume.' });
    await runCommsCycle(cfg, fast);
    expect(sends().map((c) => c.body['text'])).toContain('Phantom update:\nSeat grok reset — lanes resume.');
    expect(listThread().find((x) => x.id === msg.id)?.delivery?.telegram).toBe('sent');
  });
});

describe('Telegram offline inbound recovery', () => {
  it('records a reply to a delivered memo once and reports resolved=1 across cycles', async () => {
    const m = memo();
    m.questionsForMason = [];
    writeLeaderMemo(m);
    await runCommsCycle(cfg, fast);
    const target = nextId - 1;
    let polls = 0;
    setTelegramTransportForTests(async (method, body) => {
      calls.push({ method, body });
      if (method === 'getUpdates') {
        polls++;
        return { ok: true, result: [{ update_id: 80, message: { message_id: 90, chat: { id: 7 }, text: 'Thanks, keep me posted', reply_to_message: { message_id: target } } }] };
      }
      return { ok: true, result: { message_id: nextId++ } };
    });
    expect((await runCommsCycle(cfg, fast)).resolved).toBe(1);
    expect((await runCommsCycle(cfg, fast)).resolved).toBe(0);
    expect(polls).toBe(2);
    expect(listThread().filter(m => m.from === 'mason' && m.text.includes('keep me posted'))).toHaveLength(1);
    expect(sends().some(c => String(c.body['text']).includes('Reply recorded'))).toBe(true);
    expect(calls.filter(c => c.method === 'getUpdates').at(-1)?.body['offset']).toBe(81);
  });

  it('retains a failed acknowledgement and retries without recording the reply twice', async () => {
    const message = postLeaderMessage({ channel: 'telegram', kind: 'update', text: 'Checking in' });
    await runCommsCycle(cfg, fast);
    const target = nextId - 1;
    let fail = true;
    let polls = 0;
    setTelegramTransportForTests(async (method, body) => {
      calls.push({ method, body });
      if (method === 'getUpdates') {
        polls++;
        return { ok: true, result: [{ update_id: 100, message: { message_id: 101, chat: { id: 7 }, text: 'Noted', reply_to_message: { message_id: target } } }] };
      }
      if (method === 'sendMessage' && fail) return { ok: false, error_code: 500 };
      return { ok: true, result: { message_id: nextId++ } };
    });
    expect((await runCommsCycle(cfg, fast)).resolved).toBe(0);
    fail = false;
    expect((await runCommsCycle(cfg, fast)).resolved).toBe(1);
    expect(polls).toBe(1);
    expect(listThread().filter(m => m.from === 'mason' && m.replyTo === message.id)).toHaveLength(1);
  });

  it.each(['status', 'queue', 'usage', 'approvals'])('answers /%s through the Bot API without a daemon', async command => {
    setTelegramTransportForTests(async (method, body) => {
      calls.push({ method, body });
      if (method === 'getUpdates') return { ok: true, result: [{ update_id: 120, message: { message_id: 121, chat: { id: 7 }, text: `/${command}` } }] };
      return { ok: true, result: { message_id: nextId++ } };
    });
    expect((await runCommsCycle(cfg, fast)).resolved).toBe(1);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]?.body['reply_parameters']).toMatchObject({ message_id: 121 });
    expect(String(sends()[0]?.body['text'])).toMatch(/poller|Queue|Usage|approvals/);
    expect(calls.find(c => c.method === 'deleteWebhook')?.body).toEqual({ drop_pending_updates: false });
  });
});


describe('Telegram value-free diagnostics', () => {
  it('reports missing credentials, clears webhooks without dropping updates, and logs numeric API errors only', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previous = process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_BOT_TOKEN'];
    const secret = '123456789:' + 'A'.repeat(35);
    try {
      const missing = { ...cfg, comms: { ...cfg.comms!, telegram: { chatId: '7' } } };
      await pollTelegramUpdates(missing);
      expect(readTelegramHealth(missing).tokenPresent).toBe(false);
      expect(err.mock.calls.flat().join(' ')).toContain('Phantom Secrets');
      const methods: string[] = [];
      setTelegramTransportForTests(async method => {
        methods.push(method);
        return method === 'deleteWebhook' ? { ok: true, result: true } : { ok: false, error_code: 409, description: secret };
      });
      await pollTelegramUpdates(cfg);
      expect(methods).toEqual(['deleteWebhook', 'getUpdates']);
      expect(err.mock.calls.flat().join(' ')).toContain('409');
      expect(readTelegramHealth(cfg)).toMatchObject({ pollerAlive: true, lastSuccess: null, tokenPresent: true });
      const log = readFileSync(join(home, '.ashlr', 'comms', 'telegram-health.json'), 'utf8');
      expect(JSON.stringify([err.mock.calls, out.mock.calls, log])).not.toContain(secret);
      setTelegramTransportForTests(async () => { throw new Error(secret); });
      await pollTelegramUpdates(cfg);
      expect(JSON.stringify(err.mock.calls)).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env['TELEGRAM_BOT_TOKEN']; else process.env['TELEGRAM_BOT_TOKEN'] = previous;
      err.mockRestore(); out.mockRestore();
    }
  });

  it('formats populated queue and usage snapshots without disclosing extra fields', async () => {
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'queue.v1.json'), JSON.stringify({ items: [{ id: 'RQ-1', status: 'pending', title: 'Repair bot', token: 'private-extra-field' }] }));
    writeFileSync(join(home, '.ashlr', 'fleet.json'), JSON.stringify({ pools: [{ name: 'codex', used: 25, limit: 100, token: 'private-extra-field' }] }));
    const { localTelegramCommand } = await import('../src/core/comms/telegram-local.js');
    const queue = await localTelegramCommand('/queue', cfg);
    const usage = await localTelegramCommand('/usage', cfg);
    expect(queue).toContain('RQ-1: pending Repair bot');
    expect(usage).toContain('[###.......] 25%');
    expect(queue + usage).not.toContain('private-extra-field');
  });

  it('prints health JSON and fails cycle clearly when the token is missing', async () => {
    const { cmdComms } = await import('../src/cli/comms.js');
    const previous = process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_BOT_TOKEN'];
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'config.json'), JSON.stringify({ comms: { enabled: true, channel: 'telegram', telegram: { chatId: '7' } } }));
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdComms(['health', '--json'])).toBe(0);
      expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({ tokenPresent: false, pollerAlive: false, lastUpdateId: null });
      expect(await cmdComms(['cycle'])).toBe(1);
      expect(err.mock.calls.flat().join(' ')).toContain('Phantom Secrets');
      expect(calls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env['TELEGRAM_BOT_TOKEN']; else process.env['TELEGRAM_BOT_TOKEN'] = previous;
      out.mockRestore(); err.mockRestore();
    }
  });
});

it('surfaces a failed leader tick without printing the provider failure text', async () => {
  const leader = await import('../src/core/vision/leader.js');
  const { runLeaderCli } = await import('../src/cli/leader.js');
  const deps = vi.spyOn(leader, 'loadDefaultLeaderRunDeps').mockRejectedValue(new Error('provider-private-failure'));
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await runLeaderCli(['tick', '--wait'])).toBe(1);
    expect(readTelegramHealth(cfg).leaderTick).toBe('failed');
    expect(JSON.stringify([out.mock.calls, err.mock.calls])).not.toContain('provider-private-failure');
    expect(err.mock.calls.flat().join(' ')).toContain('Leader run failed');
  } finally { deps.mockRestore(); out.mockRestore(); err.mockRestore(); }
});

it('marks a completed tick with a no-seat run as failed instead of exit zero', async () => {
  const leader = await import('../src/core/vision/leader.js');
  const { runLeaderCli } = await import('../src/cli/leader.js');
  const deps = vi.spyOn(leader, 'loadDefaultLeaderRunDeps').mockResolvedValue({} as Awaited<ReturnType<typeof leader.loadDefaultLeaderRunDeps>>);
  const tick = vi.spyOn(leader, 'leaderTick').mockResolvedValue({ applied: [], graded: [], started: true,
    due: { due: true, trigger: 'schedule', reason: 'daily run due' },
    run: { outcome: 'no-seat', reason: 'private-provider-detail', memo: null } });
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await runLeaderCli(['tick', '--wait'])).toBe(1);
    expect(readTelegramHealth(cfg).leaderTick).toBe('failed');
    expect(JSON.stringify([out.mock.calls, err.mock.calls])).not.toContain('private-provider-detail');
  } finally { deps.mockRestore(); tick.mockRestore(); out.mockRestore(); err.mockRestore(); }
});
