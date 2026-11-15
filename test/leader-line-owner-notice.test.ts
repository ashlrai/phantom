/**
 * The Leader line shows what it sends on Telegram in the owner thread too.
 * Telegram and the owner thread are both stubbed behind LeaderLineDeps; HOME is
 * a fresh tmp dir so no real state is read or written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLeaderLine, setLeaderLineDepsForTest, type LeaderLineDeps } from '../src/core/comms/leader-line.js';
import type { AshlrConfig } from '../src/core/types.js';

const NOON = Date.parse('2026-09-27T12:30:00-04:00');
const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token-notice', chatId: '424242' }, leaderLine: true } } as AshlrConfig;

let home = '';
const savedHome = process.env['HOME'];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leader-line-notice-'));
  process.env['HOME'] = home;
});
afterEach(() => {
  setLeaderLineDepsForTest(null);
  if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function deps(over: Partial<LeaderLineDeps>): Partial<LeaderLineDeps> {
  const report = { day: '2026-09-27', text: 'Self-improvement report for the owner thread test.', actionIds: [] as string[], postedAt: null as string | null };
  return {
    now: () => NOON,
    narrative: async () => null,
    isAnswered: () => false,
    driveReport: () => report,
    markDriveReportPosted: () => undefined,
    events: async () => [],
    leaderHealth: () => null,
    taskStatus: async () => null,
    thread: async () => null,
    ...over,
  };
}

describe('Leader line posts into the owner thread', () => {
  it('hands each sent post to ownerNotice once, with a stable key', async () => {
    const notices: Array<{ text: string; key: string }> = [];
    setLeaderLineDepsForTest(deps({
      sendTelegram: async () => ({ ok: true, messageId: 9001 }),
      ownerNotice: async (text, key) => { notices.push({ text, key }); return { status: 'accepted' }; },
    }));
    const res = await runLeaderLine(cfg);
    expect(res.driveReport).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('Self-improvement report for the owner thread test.');
    expect(notices[0]!.key).toMatch(/^line-[a-f0-9]{16}$/);
  });

  it('does not post when Telegram refuses the send', async () => {
    const notices: string[] = [];
    setLeaderLineDepsForTest(deps({
      sendTelegram: async () => ({ ok: false }),
      ownerNotice: async (text) => { notices.push(text); },
    }));
    expect((await runLeaderLine(cfg)).driveReport).toBe(false);
    expect(notices).toHaveLength(0);
  });

  it('a throwing ownerNotice never changes the Telegram result or breaks the run', async () => {
    let attempts = 0;
    setLeaderLineDepsForTest(deps({
      sendTelegram: async () => ({ ok: true, messageId: 9002 }),
      ownerNotice: async () => { attempts += 1; throw new Error('owner thread exploded'); },
    }));
    const res = await runLeaderLine(cfg);
    expect(attempts).toBe(1);
    expect(res.driveReport).toBe(true);
    expect(res.pings).toBe(1);
  });
});
