import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTmpHome } from './helpers/leader-310b-fakes.js';
import { leaderRoot } from '../src/core/vision/leader-memo.js';
import { listLeaderThread } from '../src/core/vision/leader-thread.js';
import { parsePlanLog, planReplyId, replyLine } from '../src/core/fleet/mason-outbox.js';
import { runLeaderCli } from '../src/cli/leader.js';

// The leader's real line shape (RQ-LEADERREPLYN16NQ8): an approximate "~HH:MM"
// heading time and a parenthetical note between the label and the quoted reply.
const FIXTURE = [
  '# Leader plan log',
  '## 2026-11-16 ~21:50 ET (Opus leader on fake-host)',
  '- checked the queue',
  '**Reply for Mason** (for OUTBOXFALLBACK to copy): "Update 10 PM Nov 16: queue is draining."',
  '## 2026-11-16 ~22:10 ET (Opus leader on fake-host)',
  '- planning only, nothing for Mason this pass',
  '## 2026-11-16 ~22:55 ET (Opus leader on fake-host)',
  '**Reply for Mason** (for OUTBOXFALLBACK to copy): "Update 11 PM Nov 16: main is "green" everywhere."',
  '## Late pass (Opus leader on fake-host)',
  '**Reply for Mason** (for OUTBOXFALLBACK to copy): "No clock on this one."',
  '',
].join('\n');

describe('parsePlanLog on the leader line shape', () => {
  it('returns each reply with its heading time, plain text and a heading id', () => {
    const replies = parsePlanLog(FIXTURE);
    expect(replies.map(r => [r.at, r.text])).toEqual([
      ['2026-11-16 21:50', 'Update 10 PM Nov 16: queue is draining.'],
      ['2026-11-16 22:55', 'Update 11 PM Nov 16: main is "green" everywhere.'],
      ['', 'No clock on this one.'],
    ]);
    expect(replies.map(r => r.id)).toEqual([
      planReplyId('2026-11-16 ~21:50 ET (Opus leader on fake-host)'),
      planReplyId('2026-11-16 ~22:55 ET (Opus leader on fake-host)'),
      planReplyId('Late pass (Opus leader on fake-host)'),
    ]);
    expect(new Set(replies.map(r => r.id)).size).toBe(3);
    expect(parsePlanLog(FIXTURE).map(r => r.id)).toEqual(replies.map(r => r.id));
  });

  it('skips an entry with no reply and returns nothing for an empty file', () => {
    expect(parsePlanLog(FIXTURE).some(r => r.text.includes('planning only'))).toBe(false);
    expect(parsePlanLog('')).toEqual([]);
  });

  it('prints one plain line per reply and "unknown" for a missing time', () => {
    const lines = parsePlanLog(FIXTURE).map(replyLine);
    expect(lines[1]).toBe('2026-11-16 22:55  Update 11 PM Nov 16: main is "green" everywhere.');
    expect(lines[2]).toBe('unknown  No clock on this one.');
    expect(replyLine({ at: '', text: 'two\nlines' })).toBe('unknown  two lines');
  });

  it('keeps the older label shapes working', () => {
    expect(parsePlanLog('## 2026-11-09 01:00 ET\n**Reply for Mason:** Plain answer').map(r => [r.at, r.text]))
      .toEqual([['2026-11-09 01:00', 'Plain answer']]);
    expect(parsePlanLog('## 2026-11-09 9:05 ET\nReply for Mason: "Quoted"').map(r => [r.at, r.text]))
      .toEqual([['2026-11-09 09:05', 'Quoted']]);
  });
});

describe('phm leader replies and the Leader thread', () => {
  const home = useTmpHome();
  let plan: string;
  beforeEach(() => {
    home.setup();
    vi.stubEnv('ASHLR_RUNS_DIR', join(leaderRoot(), 'runs'));
    vi.stubEnv('PHANTOM_PLAN_LOG', '');
    mkdirSync(join(leaderRoot(), 'runs/leader'), { recursive: true });
    plan = join(leaderRoot(), 'runs/leader/PLAN-LOG.md');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); home.teardown(); });

  it('prints dated replies newest first as plain lines and as JSON with ids', async () => {
    writeFileSync(plan, FIXTURE);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runLeaderCli(['replies'])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0]).split('\n')).toEqual([
      '2026-11-16 22:55  Update 11 PM Nov 16: main is "green" everywhere.',
      '2026-11-16 21:50  Update 10 PM Nov 16: queue is draining.',
    ]);
    expect(await runLeaderCli(['replies', '--json'])).toBe(0);
    const result = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(result.sourceState).toBe('healthy');
    expect(result.entries.map((e: { id: string; at: string }) => [e.id, e.at])).toEqual([
      [planReplyId('2026-11-16 ~22:55 ET (Opus leader on fake-host)'), '2026-11-16 22:55'],
      [planReplyId('2026-11-16 ~21:50 ET (Opus leader on fake-host)'), '2026-11-16 21:50'],
    ]);
  });

  it('defaults to the newest 10 replies', async () => {
    writeFileSync(plan, Array.from({ length: 12 }, (_, i) => `## 2026-11-16 ~${String(i + 8).padStart(2, '0')}:00 ET\n**Reply for Mason** (for OUTBOXFALLBACK to copy): "Reply ${i}"`).join('\n'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runLeaderCli(['replies', '--json'])).toBe(0);
    const texts = JSON.parse(String(log.mock.calls.at(-1)![0])).entries.map((e: { text: string }) => e.text);
    expect(texts).toHaveLength(10);
    expect(texts[0]).toBe('Reply 11');
  });

  it('an empty file prints the no-replies line', async () => {
    writeFileSync(plan, '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runLeaderCli(['replies'])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toBe('No replies yet.');
  });

  it('shows the replies in the Leader thread, timed, scrubbed and oldest first', async () => {
    writeFileSync(plan, FIXTURE.replace('queue is draining.', 'queue is draining, see fake.person@example.com.'));
    const messages = await listLeaderThread();
    const dated = messages.filter(m => m.at);
    expect(dated.map(m => [m.at, m.from, m.kind])).toEqual([
      // 21:50 and 22:55 EST are 02:50 and 03:55 UTC the next day.
      ['2026-11-17T02:50:00.000Z', 'leader', 'answer'],
      ['2026-11-17T03:55:00.000Z', 'leader', 'answer'],
    ]);
    expect(dated[0]!.text).not.toContain('fake.person@example.com');
    expect(dated[1]!.text).toBe('Update 11 PM Nov 16: main is "green" everywhere.');
    expect(messages.find(m => !m.at)?.text).toBe('No clock on this one.');
  });
});
