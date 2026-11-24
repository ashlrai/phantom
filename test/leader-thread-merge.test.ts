/** One Leader thread from the inbox, outbox and plan log, with or without --since/--before. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLeaderCli } from '../src/cli/leader.js';
import { mergeLeaderThread, parseThreadWindow, prRefs, readLeaderThread } from '../src/core/fleet/leader-thread-merge.js';
import { handleLeaderThreadMerged, VERSE_LEADER_THREAD_MERGED_PATH } from '../src/core/verse/leader-thread-merged-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const none = { inbox: '', outbox: '', planLog: '' };
const HEADING = '## 2026-11-17 09:40 ET (Mason, Phantom desktop) PRIORITY P0\nShip the billing fix\n';
const LINE = '2026-11-17T14:30:00.000Z [src:phone id:phone-1] Is the release green?\n';
const OUTBOX = '# Outbox\n\n## 2026-11-17 10:00 ET\nBilling fix is merging now\n';
const PLAN = '## 2026-11-17 10:05 ET plan\n**Reply for Mason**: "Billing fix is merging now"\n';

describe('mergeLeaderThread', () => {
  it('reads both inbox forms', () => {
    const thread = mergeLeaderThread({ ...none, inbox: `${HEADING}\n${LINE}` });
    expect(thread.map(e => [e.from, e.channel, e.text, e.source])).toEqual([
      ['mason', 'phone', 'Is the release green?', 'inbox'],
      ['mason', 'desktop', 'Ship the billing fix', 'inbox'],
    ]);
    expect(thread[0]!.at).toBe('2026-11-17T14:30:00.000Z');
  });

  it('shows a reply found in both the outbox and the plan log once', () => {
    const thread = mergeLeaderThread({ inbox: HEADING, outbox: OUTBOX, planLog: PLAN });
    expect(thread.filter(e => e.from === 'leader')).toHaveLength(1);
    expect(thread.map(e => e.from)).toEqual(['mason', 'leader']);
    expect(thread[1]).toMatchObject({ source: 'outbox', text: 'Billing fix is merging now' });
  });

  it('takes a plan-log reply date from the nearest heading above it', () => {
    const [reply] = mergeLeaderThread({ ...none, planLog: PLAN });
    expect(reply).toMatchObject({ from: 'leader', source: 'plan-log', text: 'Billing fix is merging now' });
    expect(reply!.at).toBe('2026-11-17T15:05:00.000Z');
  });

  it('keeps an entry with no readable date, at: null, last', () => {
    const thread = mergeLeaderThread({ ...none, inbox: `## not a date (Mason, phone)\nWho am I?\n\n${LINE}` });
    expect(thread.map(e => e.text)).toEqual(['Is the release green?', 'Who am I?']);
    expect(thread[1]!.at).toBeNull();
  });

  it('skips a stray flag line such as --help', () => {
    const thread = mergeLeaderThread({ ...none, inbox: `--help\n\n${HEADING}--help\n\n2026-11-17T15:00:00.000Z [src:cli] --help\n` });
    expect(thread.map(e => e.text)).toEqual(['Ship the billing fix']);
  });

  it('marks a teammate heading and an empty who as such', () => {
    const thread = mergeLeaderThread({ ...none, inbox: '## 2026-11-17 09:00 ET (Evan, bus) PRIORITY P1\nHi\n\n## 2026-11-17 09:30 ET ()\nYo\n' });
    expect(thread.map(e => e.from)).toEqual(['teammate', 'unknown']);
  });

  it('is empty for three empty sources', () => {
    expect(mergeLeaderThread(none)).toEqual([]);
  });

  it('--since drops old dated entries but never an undated one', () => {
    const now = Date.parse('2026-11-17T15:00:00Z');
    const thread = mergeLeaderThread({ ...none, inbox: `## nope (Mason, phone)\nNo date\n\n${HEADING}\n${LINE}` }, { nowMs: now, sinceHours: 0.4 });
    expect(thread.map(e => e.text)).toEqual(['Ship the billing fix', 'No date']);
  });

  it('--before drops entries at or after the ceiling but never an undated one', () => {
    const inbox = '## nope (Mason, phone)\nNo date\n\n'
      + '2026-11-17T10:00:00.000Z [src:phone] Early\n'
      + '2026-11-17T12:00:00.000Z [src:phone] On the bound\n'
      + '2026-11-17T14:00:00.000Z [src:phone] Late\n';
    const thread = mergeLeaderThread({ ...none, inbox }, { beforeAt: '2026-11-17T12:00:00.000Z' });
    expect(thread.map(e => e.text)).toEqual(['Early', 'No date']);
  });

  it('--before hours is a relative ceiling and composes with --since as [since, before)', () => {
    const now = Date.parse('2026-11-17T15:00:00Z');
    const inbox = '## nope (Mason, phone)\nNo date\n\n'
      + '2026-11-17T10:00:00.000Z [src:phone] Too old\n'
      + '2026-11-17T13:00:00.000Z [src:phone] Inside\n'
      + '2026-11-17T14:30:00.000Z [src:phone] Too new\n';
    const windowed = mergeLeaderThread({ ...none, inbox }, { nowMs: now, sinceHours: 3, beforeHours: 1 });
    expect(windowed.map(e => e.text)).toEqual(['Inside', 'No date']);
    const bounded = mergeLeaderThread({ ...none, inbox }, { nowMs: now, beforeHours: 1 });
    expect(bounded.map(e => e.text)).toEqual(['Too old', 'Inside', 'No date']);
  });

  it('parses PR numbers from the text, once each, ascending', () => {
    const thread = mergeLeaderThread({ ...none, outbox: '## 2026-11-17 10:00 ET\nMerged #7873 and PR 7871, then #7873 again; see github.com/x/y/pull/12\n' });
    expect(thread[0]!.refs).toEqual([12, 7871, 7873]);
    expect(prRefs('no refs here, issue-ish 5 and abc#')).toEqual([]);
  });

  it('merges inbox, outbox and a plan-log-only reply in time order', () => {
    const planOnly = '## 2026-11-17 11:05 ET plan\n**Reply for Mason**: "Release shipped in #7877"\n';
    const thread = mergeLeaderThread({ inbox: HEADING, outbox: OUTBOX, planLog: PLAN + planOnly });
    expect(thread.map(e => [e.from, e.source])).toEqual([['mason', 'inbox'], ['leader', 'outbox'], ['leader', 'plan-log']]);
    expect(thread[2]!.refs).toEqual([7877]);
  });

  it('--limit keeps the newest n, newest last; since a time drops older ones', () => {
    const inbox = `${HEADING}\n${LINE}`;
    const t = { inbox, outbox: OUTBOX, planLog: '' };
    expect(mergeLeaderThread(t, { limit: 1 }).map(e => e.text)).toEqual(['Billing fix is merging now']);
    expect(mergeLeaderThread(t, { sinceAt: '2026-11-17T14:45:00Z' }).map(e => e.text)).toEqual(['Billing fix is merging now']);
    expect(mergeLeaderThread(t, { limit: 0 })).toEqual([]);
  });
});

describe('parseThreadWindow', () => {
  it('reads hours, a date and a limit; refuses nonsense', () => {
    expect(parseThreadWindow('2', '5')).toEqual({ sinceHours: 2, limit: 5 });
    expect(parseThreadWindow('2026-11-17', undefined)).toEqual({ sinceAt: '2026-11-17T00:00:00.000Z' });
    expect(parseThreadWindow(undefined, undefined)).toEqual({});
    for (const bad of [['abc', undefined], ['0', undefined], [undefined, '0'], [undefined, 'x'], ['99999', undefined]] as const) expect(parseThreadWindow(bad[0], bad[1])).toBeNull();
  });

  it('reads --before as hours or a date on the same grammar and refuses nonsense', () => {
    expect(parseThreadWindow(undefined, undefined, '2')).toEqual({ beforeHours: 2 });
    expect(parseThreadWindow('1', '5', '2026-11-17')).toEqual({ sinceHours: 1, limit: 5, beforeAt: '2026-11-17T00:00:00.000Z' });
    expect(parseThreadWindow(undefined, undefined, '2026-11-17T12:30:00Z')).toEqual({ beforeAt: '2026-11-17T12:30:00.000Z' });
    for (const bad of ['abc', '0', '99999', '-1', ''] as const) expect(parseThreadWindow(undefined, undefined, bad)).toBeNull();
  });
});

describe('phm leader thread', () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'leader-thread-'));
    mkdirSync(join(runsDir, 'leader'));
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    vi.stubEnv('PHANTOM_PLAN_LOG', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(runsDir, { recursive: true, force: true }); });

  it('uses the merged shape without --since and includes old, undated and plan-only messages', async () => {
    const old = '2020-01-01T00:00:00Z [src:phone] Old question\n';
    writeFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), '## no date (Mason, desktop)\nUndated note\n' + old + LINE);
    writeFileSync(join(runsDir, 'leader', 'MASON-OUTBOX.md'), OUTBOX);
    writeFileSync(join(runsDir, 'leader', 'PLAN-LOG.md'), PLAN + '## 2026-11-17 11:05 ET plan\n**Reply for Mason**: "Shipped #7877"\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runLeaderCli(['thread', '--json'])).toBe(0);
    const read = JSON.parse(String(log.mock.calls.at(-1)![0])) as Awaited<ReturnType<typeof readLeaderThread>>;
    expect(read.schema).toBe('leader.thread.v1');
    expect(read.sources).toEqual({ inbox: 'healthy', outbox: 'healthy', planLog: 'healthy' });
    expect(read.thread.map(e => e.text)).toEqual(['Old question', 'Is the release green?', 'Billing fix is merging now', 'Shipped #7877', 'Undated note']);
    expect(read.thread[3]).toMatchObject({ source: 'plan-log', refs: [7877] });
    expect(read.thread[4]!.at).toBeNull();
    expect(await runLeaderCli(['thread', '--since', '2020-01-01', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0])).thread).toEqual(read.thread);
  });

  it('prints merged plain lines by default, supports --text and applies --limit without --since', async () => {
    writeFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), LINE);
    writeFileSync(join(runsDir, 'leader', 'PLAN-LOG.md'), PLAN.replace('merging now', 'merged in #7873'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runLeaderCli(['thread'])).toBe(0);
    expect(log.mock.calls.map(([line]) => line).join('\n')).toContain('Mason (phone)');
    expect(log.mock.calls.map(([line]) => line).join('\n')).toContain('Leader (plan-log)');
    log.mockClear();
    expect(await runLeaderCli(['thread', '--text', '--limit', '1'])).toBe(0);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('[#7873]'));
    log.mockClear();
    expect(await runLeaderCli(['thread', '--limit', '1', '--json'])).toBe(0);
    const read = JSON.parse(String(log.mock.calls[0]![0]));
    expect(read.thread).toHaveLength(1);
    expect(read.thread[0].refs).toEqual([7873]);
  });

  it('prints the empty merged view without --since', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runLeaderCli(['thread'])).toBe(0);
    expect(log).toHaveBeenCalledExactlyOnceWith('No messages yet.');
    expect(await runLeaderCli(['thread', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ schema: 'leader.thread.v1', thread: [], sources: { inbox: 'missing', outbox: 'missing', planLog: 'missing' } });
  });

  it.each([
    ['--limit'], ['--limit', '0'], ['--json', '--text'], ['--bogus'],
    ['--legacy', '--since', '24'], ['--legacy', '--follow'],
  ])('rejects invalid or incompatible options: %j', async (...args) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runLeaderCli(['thread', ...args])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('prints the typed JSON shape and reads the fleet home from the environment', async () => {
    writeFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), LINE);
    writeFileSync(join(runsDir, 'leader', 'PLAN-LOG.md'), PLAN);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    expect(await runLeaderCli(['thread', '--since', '8000', '--json'])).toBe(0);
    const json = JSON.parse(out.join('\n')) as Awaited<ReturnType<typeof readLeaderThread>>;
    expect(json.schema).toBe('leader.thread.v1');
    expect(json.sources).toEqual({ inbox: 'healthy', outbox: 'missing', planLog: 'healthy' });
    expect(json.thread.map(e => Object.keys(e).sort())).toEqual([['at', 'channel', 'from', 'refs', 'source', 'text'], ['at', 'channel', 'from', 'refs', 'source', 'text']]);
    expect(json.thread.map(e => e.from)).toEqual(['mason', 'leader']);
  });

  it('says "No messages yet." when all three journals are missing, and honours --limit', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    expect(await runLeaderCli(['thread', '--since', '8000'])).toBe(0);
    expect(out.join('\n')).toContain('No messages');
    out.length = 0;
    writeFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), LINE);
    writeFileSync(join(runsDir, 'leader', 'PLAN-LOG.md'), PLAN.replace('merging now', 'merged in #7873'));
    expect(await runLeaderCli(['thread', '--since', '8000', '--limit', '1'])).toBe(0);
    expect(out.join('\n')).toContain('[#7873]');
    expect(out.join('\n')).not.toContain('release green');
  });

  it('rejects a bad hours value', async () => {
    const err: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
    expect(await runLeaderCli(['thread', '--since', 'abc'])).toBe(2);
    expect(err.join('\n')).toContain('Usage');
  });

  it('applies --before as an exclusive ceiling and composes with --since', async () => {
    writeFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'),
      '2026-11-17T10:00:00.000Z [src:phone] Early\n'
      + '2026-11-17T14:00:00.000Z [src:phone] On the bound\n'
      + '2026-11-17T16:00:00.000Z [src:phone] Late\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runLeaderCli(['thread', '--before', '2026-11-17T14:00:00Z', '--json'])).toBe(0);
    const read = JSON.parse(String(log.mock.calls.at(-1)![0])) as Awaited<ReturnType<typeof readLeaderThread>>;
    expect(read.thread.map(e => e.text)).toEqual(['Early']);
    log.mockClear();
    expect(await runLeaderCli(['thread', '--since', '2026-11-17T15:00:00Z', '--before', '2026-11-17T17:00:00Z', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0])).thread.map((e: { text: string }) => e.text)).toEqual(['Late']);
    log.mockClear();
    expect(await runLeaderCli(['thread', '--before', '2026-11-17T09:00:00Z'])).toBe(0);
    expect(log).toHaveBeenCalledExactlyOnceWith('No messages before 2026-11-17T09:00:00Z.');
  });

  it('rejects a bad --before value', async () => {
    const err: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
    expect(await runLeaderCli(['thread', '--before', 'abc'])).toBe(2);
    expect(err.join('\n')).toContain('Usage');
  });
});

describe('GET /api/verse/leader/thread/merged', () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'leader-thread-api-'));
    mkdirSync(join(runsDir, 'leader'));
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    vi.stubEnv('PHANTOM_PLAN_LOG', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(runsDir, { recursive: true, force: true }); });

  async function call(query = '', token: string | null = 'test-token') {
    let status = 0;
    let text = '';
    const req = Object.assign(new PassThrough(), {
      url: VERSE_LEADER_THREAD_MERGED_PATH + query,
      method: 'GET',
      headers: token === null ? {} : { 'x-ashlr-token': token },
    }) as IncomingMessage;
    const res = {
      writeHead(code: number) { status = code; return this; },
      end(body: string) { text = body; },
    } as unknown as ServerResponse;
    const handled = await handleLeaderThreadMerged(
      { cfg: {}, token: 'test-token', allowDispatch: true } as VerseApiContext, req, res, 'GET',
    );
    return { handled, status, body: text ? JSON.parse(text) : null };
  }

  it('applies before as the exclusive ceiling, 400s a bad value and 401s a bad token', async () => {
    writeFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'),
      '2026-11-17T10:00:00.000Z [src:phone] Early\n'
      + '2026-11-17T16:00:00.000Z [src:phone] Late\n');
    const ok = await call('?before=2026-11-17T14:00:00Z');
    expect(ok.handled).toBe(true);
    expect(ok.status).toBe(200);
    expect(ok.body.thread.map((e: { text: string }) => e.text)).toEqual(['Early']);
    expect((await call('?before=abc')).status).toBe(400);
    expect((await call('?before=2026-11-17', null)).status).toBe(401);
  });
});
