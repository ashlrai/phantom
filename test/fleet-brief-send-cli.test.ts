import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetBriefSend } from '../src/cli/fleet-brief-send.js';
import { readDailyBriefStamp } from '../src/core/comms/daily-brief-send.js';

// 17:00Z on 2026-11-03 is noon in America/New_York — the fake "today".
const now = () => new Date('2026-11-03T17:00:00.000Z');
const DAY = '2026-11-03';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'brief-cli-')); dirs.push(dir); return dir; };

const planDeps = {
  isConfigured: () => true,
  composeStatus: async (channel: string) => `plainly fake status for ${channel}`,
  needsYou: () => 1,
};

describe('cmdFleetBriefSend', () => {
  it('dry-run prints the plan and sends nothing', async () => {
    const dir = root();
    const lines: string[] = [];
    const sent: string[] = [];
    const code = await cmdFleetBriefSend(['--runs-dir', dir], {
      now, planDeps, output: text => lines.push(text),
      senders: { email: async () => { sent.push('email'); } },
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('email: configured — would send');
    expect(lines.join('\n')).toContain('Needs you: 1');
    expect(lines.at(-1)).toContain('dry run');
    expect(sent).toEqual([]);
    expect(existsSync(join(dir, 'queue', 'daily-brief-last.json'))).toBe(false);
  });
  it('dry-run --json reports per-channel plan entries without sending', async () => {
    const dir = root();
    const lines: string[] = [];
    await cmdFleetBriefSend(['--runs-dir', dir, '--json'], { now, output: text => lines.push(text),
      planDeps: { isConfigured: c => c === 'telegram', composeStatus: async () => 'fake', needsYou: () => 0 } });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ apply: false, day: DAY });
    expect(parsed.entries).toEqual([
      { channel: 'email', send: false, reason: 'not-configured' },
      { channel: 'telegram', send: true, text: expect.stringContaining('Needs you: 0') },
    ]);
  });
  it('--apply writes the stamp only for channels whose sender succeeds', async () => {
    const dir = root();
    const lines: string[] = [];
    const sent: string[] = [];
    const code = await cmdFleetBriefSend(['--runs-dir', dir, '--apply'], {
      now, planDeps, output: text => lines.push(text),
      senders: {
        email: async () => { sent.push('email'); },
        telegram: async () => { sent.push('telegram'); throw new Error('fake transport down'); },
      },
    });
    expect(code).toBe(0);
    expect(lines).toEqual(['email: sent', 'telegram: failed']);
    expect(readDailyBriefStamp(dir)).toEqual({ email: DAY });
    // Second apply: email is deduped by the stamp; telegram retries and fails again.
    await cmdFleetBriefSend(['--runs-dir', dir, '--apply'], {
      now, planDeps, output: text => lines.push(text),
      senders: { email: async () => { sent.push('email-again'); }, telegram: async () => { throw new Error('down'); } },
    });
    expect(sent).toEqual(['email', 'telegram']);
    expect(lines.slice(2)).toEqual(['email: skipped — already-sent-today', 'telegram: failed']);
  });
  it('--channel limits the plan to one channel', async () => {
    const dir = root();
    const lines: string[] = [];
    await cmdFleetBriefSend(['--runs-dir', dir, '--channel', 'telegram', '--json'], { now, planDeps, output: t => lines.push(t) });
    expect(JSON.parse(lines[0]!).entries).toEqual([{ channel: 'telegram', send: true, text: expect.any(String) }]);
  });
  it('refuses bad arguments and an unknown channel with exit 2', async () => {
    const errors: string[] = [];
    const deps = { now, planDeps, output: () => {}, error: (t: string) => errors.push(t) };
    expect(await cmdFleetBriefSend(['--bogus'], deps)).toBe(2);
    expect(await cmdFleetBriefSend(['--channel', 'pager'], deps)).toBe(2);
    expect(await cmdFleetBriefSend(['--apply', '--apply'], deps)).toBe(2);
    expect(await cmdFleetBriefSend(['--help'], deps)).toBe(0);
    expect(errors.length).toBeGreaterThan(0);
  });
});
