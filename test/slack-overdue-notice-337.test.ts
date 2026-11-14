import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';
import { readOwnerThread } from '../src/core/comms/owner-thread.js';
import { noticeOverdueSlackRequests } from '../src/core/comms/teammate-overdue.js';
import { runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickSteps } from '../src/core/fleet/self-tick.js';

const CH = 'C0FAKE0001';
const THREAD = '1700000000.000100';
const NOW = Date.parse('2023-11-15T00:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

let dir: string, runsDir: string, stateRoot: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'slack-overdue-337-')); runsDir = join(dir, 'runs'); stateRoot = join(dir, 'state'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ingest = (minutes: number, ts = THREAD) =>
  recordSlackObservation({ at: minsAgo(minutes), decision: 'ingested', channelId: CH, messageTs: ts, threadTs: THREAD }, { runsDir });
const opts = (apply = true) => ({ runsDir, stateRoot, now: () => NOW, apply });
const thread = () => readOwnerThread({ runsDir, settings: emptyOwnerSettings() }).messages.map(m => m.text);
const seenPath = () => join(runsDir, 'queue', 'slack-overdue-seen.json');

describe('slack overdue notice (337)', () => {
  it('raises one notice for a 10 min old unanswered request, once', async () => {
    ingest(10);
    expect(await noticeOverdueSlackRequests(opts())).toEqual({ state: 'ok', raised: 1, skipped: 0 });
    expect(existsSync(seenPath())).toBe(true);
    const texts = thread();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(CH);
    expect(texts[0]).toContain('10 min');
    expect(await noticeOverdueSlackRequests(opts())).toEqual({ state: 'ok', raised: 0, skipped: 1 });
    expect(thread()).toHaveLength(1);
  });

  it('skips a request answered by a same-thread sent receipt', async () => {
    ingest(10);
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages: {
      ['0'.repeat(64)]: { digest: 'a'.repeat(64), clientId: '11111111-1111-1111-1111-111111111111', expiresAt: 9e12, channel: CH, thread: THREAD, state: 'sent', ts: '1700000050.000100' },
    } }), { mode: 0o600 });
    expect(await noticeOverdueSlackRequests(opts())).toEqual({ state: 'ok', raised: 0, skipped: 0 });
    expect(thread()).toHaveLength(0);
  });

  it('ignores a request under the threshold', async () => {
    ingest(2);
    expect(await noticeOverdueSlackRequests(opts())).toEqual({ state: 'ok', raised: 0, skipped: 0 });
  });

  it('dry run counts skipped and writes nothing', async () => {
    ingest(10);
    expect(await noticeOverdueSlackRequests(opts(false))).toEqual({ state: 'ok', raised: 0, skipped: 1 });
    expect(existsSync(seenPath())).toBe(false);
    expect(thread()).toHaveLength(0);
  });

  it('is unavailable on a degraded journal', async () => {
    ingest(10);
    writeFileSync(slackJournalPath(runsDir), '{bad line\n', { flag: 'a' });
    expect(await noticeOverdueSlackRequests(opts())).toEqual({ state: 'unavailable', raised: 0, skipped: 0 });
    expect(thread()).toHaveLength(0);
  });

  it('is unavailable on an invalid seen file', async () => {
    ingest(10);
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(seenPath(), JSON.stringify([1, 2]));
    expect(await noticeOverdueSlackRequests(opts())).toEqual({ state: 'unavailable', raised: 0, skipped: 0 });
    expect(thread()).toHaveLength(0);
  });

  it('self-tick default teammate-overdue runner reports a slack key', async () => {
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    const ok = async () => ({ exitCode: 0, output: '{}' });
    const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.filter(n => n !== 'teammate-overdue').map(n => [n, ok])) as SelfTickSteps;
    const { report } = await runSelfTick({ runsDir, steps, now: () => NOW });
    const step = report.steps.find(s => s.step === 'teammate-overdue');
    expect(step?.state).toBe('ok');
    expect(step?.report).toHaveProperty('slack');
  });
});
