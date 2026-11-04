import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDailyBriefPlan, DAILY_BRIEF_MAX_CHARS, DAILY_BRIEF_STAMP, dailyBriefLocalDay,
  dailyBriefText, planDailyBrief, readDailyBriefStamp } from '../src/core/comms/daily-brief-send.js';

// 17:00Z on 2026-11-03 is noon in America/New_York (EST, DST ended Nov 1).
const now = () => new Date('2026-11-03T17:00:00.000Z');
const DAY = '2026-11-03';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'daily-brief-'));
  dirs.push(root);
  mkdirSync(join(root, 'queue'), { recursive: true });
  return root;
}

const planDeps = {
  isConfigured: () => true,
  composeStatus: async (channel: string) => `plainly fake status for ${channel}`,
  needsYou: () => 2,
};

describe('dailyBriefLocalDay', () => {
  it('renders the America/New_York calendar day', () => {
    expect(dailyBriefLocalDay(now())).toBe(DAY);
    // 04:30Z is still the previous evening in New York.
    expect(dailyBriefLocalDay(new Date('2026-11-03T04:30:00.000Z'))).toBe('2026-11-02');
  });
});

describe('dailyBriefText', () => {
  it('leads with the needs-you count before the status counts', () => {
    const text = dailyBriefText(3, 'Runs status: available\nrunning: 4');
    expect(text.split('\n')[0]).toBe('Needs you: 3');
    expect(text).toContain('running: 4');
  });
  it('reports the count as unavailable when the ledger cannot be read', () => {
    expect(dailyBriefText(null, 'x').split('\n')[0]).toBe('Needs you: unavailable');
  });
  it('never exceeds 1200 chars, cutting at a line boundary', () => {
    const text = dailyBriefText(0, `line\n${'x'.repeat(3000)}\nlast`);
    expect(text.length).toBeLessThanOrEqual(DAILY_BRIEF_MAX_CHARS);
    expect(text).toBe('Needs you: 0\nline');
  });
});

describe('planDailyBrief', () => {
  it('plans a send for each configured channel with no stamp', async () => {
    const plan = await planDailyBrief({ runsDir: fixture(), now, ...planDeps });
    expect(plan.day).toBe(DAY);
    expect(plan.entries).toMatchObject([{ channel: 'email', send: true }, { channel: 'telegram', send: true }]);
  });
  it('skips a channel already stamped today and resends the next day', async () => {
    const root = fixture();
    let plan = await planDailyBrief({ runsDir: root, now, lastSent: { email: DAY }, ...planDeps });
    expect(plan.entries[0]).toMatchObject({ channel: 'email', send: false, reason: 'already-sent-today' });
    expect(plan.entries[1]).toMatchObject({ channel: 'telegram', send: true });
    plan = await planDailyBrief({ runsDir: root, now, lastSent: { email: '2026-11-02' }, ...planDeps });
    expect(plan.entries[0]).toMatchObject({ channel: 'email', send: true });
  });
  it('skips unconfigured channels without erroring', async () => {
    const plan = await planDailyBrief({
      runsDir: fixture(), now, needsYou: () => 0,
      isConfigured: channel => channel === 'email',
      composeStatus: async () => 'fake',
    });
    expect(plan.entries).toEqual([
      { channel: 'email', send: true, text: expect.stringContaining('fake') },
      { channel: 'telegram', send: false, reason: 'not-configured' },
    ]);
  });
  it('skips a channel whose status composer throws', async () => {
    const plan = await planDailyBrief({
      runsDir: fixture(), now, needsYou: () => 0, isConfigured: () => true,
      composeStatus: async channel => { if (channel === 'telegram') throw new Error('reader down'); return 'fake'; },
    });
    expect(plan.entries[1]).toEqual({ channel: 'telegram', send: false, reason: 'status-unavailable' });
  });
});

describe('readDailyBriefStamp', () => {
  it('returns {} for missing or malformed stamps and drops bad values', async () => {
    const root = fixture();
    expect(readDailyBriefStamp(root)).toEqual({});
    writeFileSync(join(root, DAILY_BRIEF_STAMP), 'not json');
    expect(readDailyBriefStamp(root)).toEqual({});
    writeFileSync(join(root, DAILY_BRIEF_STAMP), JSON.stringify({ email: DAY, telegram: 'soon', other: DAY }));
    expect(readDailyBriefStamp(root)).toEqual({ email: DAY });
  });
});

describe('applyDailyBriefPlan', () => {
  it('stamps only channels whose sender succeeds, under the lock', async () => {
    const root = fixture();
    const plan = await planDailyBrief({ runsDir: root, now, ...planDeps });
    const sent: string[] = [];
    const results = await applyDailyBriefPlan(root, plan, {
      email: async () => { sent.push('email'); },
      telegram: async () => { throw new Error('fake transport down'); },
    });
    expect(results).toEqual([
      { channel: 'email', outcome: 'sent' },
      { channel: 'telegram', outcome: 'failed' },
    ]);
    expect(readDailyBriefStamp(root)).toEqual({ email: DAY });
    // A second apply honors the stamp written inside the lock: email skips.
    const again = await applyDailyBriefPlan(root, plan, { email: async () => { sent.push('again'); } });
    expect(again[0]).toMatchObject({ outcome: 'skipped', reason: 'already-sent-today' });
    expect(sent).toEqual(['email']);
  });
  it('persists a stamp readable as { channel: YYYY-MM-DD }', async () => {
    const root = fixture();
    const plan = await planDailyBrief({ runsDir: root, now, channels: ['telegram'], ...planDeps });
    await applyDailyBriefPlan(root, plan, { telegram: async () => {} });
    expect(JSON.parse(readFileSync(join(root, DAILY_BRIEF_STAMP), 'utf8'))).toEqual({ telegram: DAY });
  });
});
