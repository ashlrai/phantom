import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetBriefSend } from '../src/cli/fleet-brief-send.js';
import { applyDailyBriefPlan, DAILY_BRIEF_MAX_CHARS, dailyBriefText, dueDailyBriefSlot,
  planDailyBrief, readDailyBriefStamp, resolveDailyBriefSlotTimes } from '../src/core/comms/daily-brief-send.js';

// EST (DST ended Nov 1): 12:40Z = 07:40 ET, 17:00Z = noon, 03:45Z Nov 4 = 22:45 ET Nov 3.
const MORNING = () => new Date('2026-11-03T12:40:00.000Z');
const NOON = () => new Date('2026-11-03T17:00:00.000Z');
const NIGHT = () => new Date('2026-11-04T03:45:00.000Z');
const EARLY = () => new Date('2026-11-03T10:00:00.000Z');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'cos-brief-')); dirs.push(dir); return dir; };
const deps = { isConfigured: () => true, composeStatus: async () => 'status body', needsYou: () => 0 };
const times = resolveDailyBriefSlotTimes({}, {});

describe('slot selection', () => {
  it('defaults to 07:30 and 22:30 and honors overrides and env', () => {
    expect(times).toEqual({ morning: '07:30', overnight: '22:30' });
    expect(resolveDailyBriefSlotTimes({ morning: '08:15' }, { ASHLR_BRIEF_OVERNIGHT_AT: '23:00' }))
      .toEqual({ morning: '08:15', overnight: '23:00' });
    expect(resolveDailyBriefSlotTimes({ morning: '25:99' }, { ASHLR_BRIEF_OVERNIGHT_AT: 'late' })).toEqual(times);
  });
  it('picks the latest slot already due in ET', () => {
    expect(dueDailyBriefSlot(EARLY(), times)).toBeNull();
    expect(dueDailyBriefSlot(MORNING(), times)).toBe('morning');
    expect(dueDailyBriefSlot(NOON(), times)).toBe('morning');
    expect(dueDailyBriefSlot(NIGHT(), times)).toBe('overnight');
  });
});

describe('needs-you list', () => {
  it('caps the list at 5 items and scrubs nothing into the count', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `item ${i}`);
    const text = dailyBriefText(8, 'body', lines);
    expect(text.split('\n').filter(l => l.startsWith('- '))).toHaveLength(5);
    expect(text.split('\n')[0]).toBe('Needs you: 8');
    expect(text.length).toBeLessThanOrEqual(DAILY_BRIEF_MAX_CHARS);
  });
  it('labels overnight and keeps morning unlabelled', () => {
    expect(dailyBriefText(1, '', ['a'], 'overnight')).toBe('Needs you: 1 (overnight)\n- a');
    expect(dailyBriefText(1, '', ['a'])).toBe('Needs you: 1\n- a');
  });
  it('skips the drafts section cleanly without a source and lists drafts with one', async () => {
    const dir = root();
    const plain = await planDailyBrief({ runsDir: dir, now: NOON, isConfigured: () => true, composeStatus: async () => 's' });
    expect(plain.entries[0]).toMatchObject({ send: true });
    expect((plain.entries[0] as { text: string }).text).not.toContain('Draft');
    const withDrafts = await planDailyBrief({ runsDir: dir, now: NOON, isConfigured: () => true, composeStatus: async () => 's',
      drafts: () => ['reply to vendor'] });
    expect((withDrafts.entries[0] as { text: string }).text).toContain('- Draft to approve: reply to vendor');
    const broken = await planDailyBrief({ runsDir: dir, now: NOON, isConfigured: () => true, composeStatus: async () => 's',
      drafts: () => { throw new Error('down'); } });
    expect(broken.entries[0]).toMatchObject({ send: true });
  });
});

describe('per-slot local-day budget', () => {
  it('lets one morning and one overnight brief through per channel per day', async () => {
    const dir = root();
    const sent: string[] = [];
    const senders = { email: async (t: string) => { sent.push(t); }, telegram: async (t: string) => { sent.push(t); } };
    const run = async (now: () => Date, slot?: 'morning' | 'overnight') => {
      const plan = await planDailyBrief({ runsDir: dir, now, slot, lastSent: readDailyBriefStamp(dir), ...deps });
      return applyDailyBriefPlan(dir, plan, senders);
    };
    expect((await run(MORNING)).map(r => r.outcome)).toEqual(['sent', 'sent']);
    expect((await run(NOON)).map(r => r.reason)).toEqual(['already-sent-today', 'already-sent-today']);
    // Overnight at 22:45 ET the same local day is a separate budget.
    expect((await run(() => new Date('2026-11-04T03:45:00.000Z'), 'overnight')).map(r => r.outcome)).toEqual(['sent', 'sent']);
    expect((await run(NIGHT, 'overnight')).map(r => r.reason)).toEqual(['already-sent-today', 'already-sent-today']);
    expect(sent).toHaveLength(4);
    expect(sent[2]).toContain('(overnight)');
    expect(readDailyBriefStamp(dir)).toEqual({
      email: '2026-11-03', telegram: '2026-11-03', emailOvernight: '2026-11-03', telegramOvernight: '2026-11-03',
    });
  });
  it('reports slot-not-due before the morning time and sends nothing', async () => {
    const plan = await planDailyBrief({ runsDir: root(), now: EARLY, ...deps });
    expect(plan.entries).toEqual([
      { channel: 'email', send: false, reason: 'slot-not-due' },
      { channel: 'telegram', send: false, reason: 'slot-not-due' },
    ]);
  });
});

describe('fleet brief-send --slot', () => {
  it('plans the requested slot as JSON and rejects bad slot or time values', async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const io = { now: EARLY, planDeps: deps, output: (t: string) => lines.push(t), error: (t: string) => errors.push(t) };
    expect(await cmdFleetBriefSend(['--runs-dir', root(), '--json', '--slot', 'overnight'], io)).toBe(0);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ apply: false, slot: 'overnight', day: '2026-11-03' });
    expect(parsed.entries[0].text).toContain('Needs you: 0 (overnight)');
    expect(await cmdFleetBriefSend(['--slot', 'noon'], io)).toBe(2);
    expect(await cmdFleetBriefSend(['--morning-at', '7:30'], io)).toBe(2);
  });
  it('--morning-at moves the due time', async () => {
    const lines: string[] = [];
    const io = { now: MORNING, planDeps: deps, output: (t: string) => lines.push(t) };
    await cmdFleetBriefSend(['--runs-dir', root(), '--json', '--morning-at', '09:00'], io);
    expect(JSON.parse(lines[0]!).entries[0]).toMatchObject({ send: false, reason: 'slot-not-due' });
  });
});
