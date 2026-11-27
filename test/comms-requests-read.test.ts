/**
 * `phm comms requests` — the filtered read of the comms request ledger.
 *
 * The ledger (`~/.ashlr/comms/requests.jsonl`) is the only comms store with
 * writes but, until this read, no filtered surface: `phm comms status`
 * counts the live queue and `phm comms inbox` lists only pending/sent
 * questions and approvals still owed an answer. Answered, expired and
 * report rows were unreadable everywhere.
 *
 * Invariants:
 *   - every lifecycle state and type lists, newest createdAt first
 *   - --status/--type repeat into exact-match sets; --kind/--id exact
 *   - --since is inclusive and --before exclusive on createdAt ([since, before))
 *   - a record whose createdAt does not parse never matches a bounded window
 *     and sorts last unfiltered — unknown never counts as fresh
 *   - --contains is a case-insensitive substring over the row's own text
 *   - --limit caps shown rows while matched keeps the full filter total
 *   - a missing store is a verified-empty ledger; an unreadable one is
 *     'unavailable' with matched null — never an empty list passed off as fact
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdComms } from '../src/cli/comms.js';
import { cmdCommsRequests } from '../src/cli/comms-requests.js';
import type { CommsRequest } from '../src/core/comms/requests.js';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'comms-requests-read-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function seed(records: Array<Partial<CommsRequest> & Pick<CommsRequest, 'id' | 'status'>>): void {
  const dir = join(tmpHome, '.ashlr', 'comms');
  mkdirSync(dir, { recursive: true });
  const lines = records.map((r) =>
    JSON.stringify({
      kind: 'test-kind',
      type: 'question',
      text: `text ${r.id}`,
      options: ['yes', 'no'],
      createdAt: iso(NOW),
      ...r,
    }),
  );
  writeFileSync(join(dir, 'requests.jsonl'), lines.join('\n') + '\n', 'utf8');
}

async function run(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdCommsRequests(args, { now: () => NOW });
  return { code, out: log.mock.calls.map((c) => String(c[0])), err: err.mock.calls.map((c) => String(c[0])) };
}

async function runJson(args: string[]): Promise<{ code: number; body: any }> {
  const { code, out } = await run([...args, '--json']);
  return { code, body: JSON.parse(out.at(-1)!) };
}

describe('phm comms requests', () => {
  it('is dispatched through phm comms and prints help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdComms(['requests', '--help'])).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('usage: phm comms requests');
  });

  it('lists every lifecycle state and type, newest createdAt first', async () => {
    seed([
      { id: 'req-old', status: 'answered', type: 'approval', kind: 'merge-gate', createdAt: iso(NOW - 4000),
        answerIndex: 0, answerText: 'ship it', answeredAt: iso(NOW - 3000) },
      { id: 'req-new', status: 'sent', type: 'question', kind: 'test-question', createdAt: iso(NOW - 1000), sentAt: iso(NOW - 900) },
      { id: 'req-mid', status: 'expired', type: 'report', kind: 'fleet-digest', createdAt: iso(NOW - 2000),
        expiredAt: iso(NOW - 1500), expiredReason: 'ttl', options: [] },
      { id: 'req-pending', status: 'pending', type: 'question', createdAt: iso(NOW - 500) },
    ]);
    const { code, body } = await runJson([]);
    expect(code).toBe(0);
    expect(body.status).toBe('available');
    expect(body.matched).toBe(4);
    expect(body.truncated).toBe(false);
    expect(body.requests.map((r: CommsRequest) => r.id)).toEqual(['req-pending', 'req-new', 'req-mid', 'req-old']);
    // The answered row keeps its recorded answer; the report kept its empty options.
    expect(body.requests.at(-1).answerText).toBe('ship it');
    expect(body.requests[2].type).toBe('report');
  });

  it('orders by createdAt, not file position — an out-of-order append still sorts by its timestamp', async () => {
    seed([
      { id: 'req-a', status: 'pending', createdAt: iso(NOW - 5000) },
      { id: 'req-b', status: 'pending', createdAt: iso(NOW - 100) },
      { id: 'req-c', status: 'pending', createdAt: iso(NOW - 3000) },
    ]);
    const { body } = await runJson([]);
    expect(body.requests.map((r: CommsRequest) => r.id)).toEqual(['req-b', 'req-c', 'req-a']);
  });

  it('filters --status as a repeatable exact-match set', async () => {
    seed([
      { id: 'req-pending', status: 'pending', createdAt: iso(NOW - 1000) },
      { id: 'req-sent', status: 'sent', createdAt: iso(NOW - 500), sentAt: iso(NOW - 400) },
      { id: 'req-answered', status: 'answered', createdAt: iso(NOW - 300), answerIndex: 0, answerText: 'yes', answeredAt: iso(NOW - 200) },
      { id: 'req-expired', status: 'expired', createdAt: iso(NOW - 100), expiredAt: iso(NOW - 50) },
    ]);
    expect((await runJson(['--status', 'sent'])).body.requests.map((r: CommsRequest) => r.id)).toEqual(['req-sent']);
    const both = await runJson(['--status', 'pending', '--status', 'sent']);
    expect(both.body.matched).toBe(2);
    expect(both.body.requests.map((r: CommsRequest) => r.id)).toEqual(['req-sent', 'req-pending']);
  });

  it('filters --type and composes it with --status', async () => {
    seed([
      { id: 'req-q', status: 'pending', type: 'question' },
      { id: 'req-a', status: 'pending', type: 'approval' },
      { id: 'req-r', status: 'answered', type: 'report', answerIndex: -1, answerText: '(report delivered)', answeredAt: iso(NOW - 100) },
    ]);
    const reports = await runJson(['--type', 'report']);
    expect(reports.body.requests.map((r: CommsRequest) => r.id)).toEqual(['req-r']);
    const approvals = await runJson(['--type', 'approval', '--type', 'report', '--status', 'answered']);
    expect(approvals.body.requests.map((r: CommsRequest) => r.id)).toEqual(['req-r']);
    expect((await runJson(['--type', 'question', '--status', 'answered'])).body.matched).toBe(0);
  });

  it('matches --kind and --id exactly', async () => {
    seed([
      { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', status: 'answered', kind: 'merge-gate', answerIndex: 0, answerText: 'yes', answeredAt: iso(NOW - 100) },
      { id: 'ffffffff-1111-2222-3333-444444444444', status: 'pending', kind: 'manager-approval' },
    ]);
    const byKind = await runJson(['--kind', 'merge-gate']);
    expect(byKind.body.requests.map((r: CommsRequest) => r.id)).toEqual(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
    const byId = await runJson(['--id', 'ffffffff-1111-2222-3333-444444444444']);
    expect(byId.body.matched).toBe(1);
    expect((await runJson(['--kind', 'MERGE-GATE'])).body.matched).toBe(0);
    expect((await runJson(['--id', 'aaaaaaaa'])).body.matched).toBe(0);
  });

  it('applies the shared [since, before) window on createdAt', async () => {
    seed([
      { id: 'req-edge-since', status: 'pending', createdAt: iso(NOW - 2000) },
      { id: 'req-mid', status: 'pending', createdAt: iso(NOW - 1000) },
      { id: 'req-edge-before', status: 'pending', createdAt: iso(NOW) },
      { id: 'req-old', status: 'pending', createdAt: iso(NOW - 5000) },
    ]);
    // since is inclusive, before is exclusive: [NOW-2000, NOW) keeps the two middle rows.
    const window = await runJson(['--since', String(NOW - 2000), '--before', String(NOW)]);
    expect(window.body.requests.map((r: CommsRequest) => r.id)).toEqual(['req-mid', 'req-edge-since']);
    expect((await runJson(['--since', '1h'])).body.matched).toBe(4);
    expect((await runJson(['--before', iso(NOW - 1500)])).body.requests.map((r: CommsRequest) => r.id))
      .toEqual(['req-edge-since', 'req-old']);
  });

  it('never lets an unparseable createdAt match a bounded window, and sorts it last unfiltered', async () => {
    seed([
      { id: 'req-bad-clock', status: 'pending', createdAt: 'not-a-time' },
      { id: 'req-good', status: 'pending', createdAt: iso(NOW - 1000) },
    ]);
    const unfiltered = await runJson([]);
    expect(unfiltered.body.requests.map((r: CommsRequest) => r.id)).toEqual(['req-good', 'req-bad-clock']);
    expect((await runJson(['--since', '1h'])).body.matched).toBe(1);
    // --before NOW keeps req-good (created NOW-1000) and still excludes the undated row.
    expect((await runJson(['--before', iso(NOW)])).body.matched).toBe(1);
  });

  it('matches --contains case-insensitively across text, kind, options and the recorded answer', async () => {
    seed([
      { id: 'req-text', status: 'answered', text: 'Ship the Phantom release?', kind: 'merge-gate',
        options: ['hold', 'ship'], answerIndex: 1, answerText: 'ship', answeredAt: iso(NOW - 100) },
      { id: 'req-kind', status: 'pending', text: 'unrelated words', kind: 'manager-approval', options: [] },
      { id: 'req-option', status: 'pending', text: 'pick one', kind: 'test', options: ['alpha', 'beta'] },
      { id: 'req-report', status: 'answered', type: 'report', text: 'Weekly numbers', kind: 'fleet-digest',
        options: [], answerIndex: -1, answerText: '(report delivered)', answeredAt: iso(NOW - 90) },
      { id: 'req-none', status: 'expired', text: 'nothing relevant', kind: 'fleet-digest', options: [], expiredAt: iso(NOW - 100) },
    ]);
    const byText = await runJson(['--contains', 'phantom release']);
    expect(byText.body.requests.map((r: CommsRequest) => r.id)).toEqual(['req-text']);
    const byKind = await runJson(['--contains', 'MANAGER-APPROVAL']);
    expect(byKind.body.requests.map((r: CommsRequest) => r.id)).toEqual(['req-kind']);
    const byOption = await runJson(['--contains', 'beta']);
    expect(byOption.body.requests.map((r: CommsRequest) => r.id)).toEqual(['req-option']);
    // '(report delivered)' appears only in the delivered report's answerText — nowhere in its text, kind or options.
    const byAnswer = await runJson(['--contains', 'report delivered']);
    expect(byAnswer.body.requests.map((r: CommsRequest) => r.id)).toEqual(['req-report']);
    // Whitespace collapses on both sides, the same rule every bus read applies.
    expect((await runJson(['--contains', '  Ship   the  '])).body.matched).toBe(1);
    expect((await runJson(['--contains', 'absent needle'])).body.matched).toBe(0);
  });

  it('caps shown rows at --limit while matched keeps the full filter total', async () => {
    seed([
      { id: 'req-1', status: 'pending', createdAt: iso(NOW - 100) },
      { id: 'req-2', status: 'pending', createdAt: iso(NOW - 200) },
      { id: 'req-3', status: 'sent', createdAt: iso(NOW - 300), sentAt: iso(NOW - 290) },
      { id: 'req-4', status: 'answered', type: 'approval', createdAt: iso(NOW - 400), answerIndex: 0, answerText: 'yes', answeredAt: iso(NOW - 390) },
    ]);
    const { code, body } = await runJson(['--limit', '2']);
    expect(code).toBe(0);
    expect(body.matched).toBe(4);
    expect(body.limit).toBe(2);
    expect(body.truncated).toBe(true);
    expect(body.requests).toHaveLength(2);
    expect(body.requests.map((r: CommsRequest) => r.id)).toEqual(['req-1', 'req-2']);
    const filtered = await runJson(['--status', 'answered', '--limit', '1']);
    expect(filtered.body.matched).toBe(1);
    expect(filtered.body.truncated).toBe(false);
  });

  it('reports a missing store as a verified-empty ledger', async () => {
    const { code, body } = await runJson([]);
    expect(code).toBe(0);
    expect(body.status).toBe('missing');
    expect(body.matched).toBe(0);
    expect(body.requests).toEqual([]);
    const { code: textCode, out } = await run([]);
    expect(textCode).toBe(0);
    expect(out.at(-1)).toBe('No requests.');
  });

  it('reports an unreadable store as unavailable — never an empty list passed off as fact', async () => {
    // A directory where the JSONL file belongs: lstat succeeds, the read fails.
    mkdirSync(join(tmpHome, '.ashlr', 'comms', 'requests.jsonl'), { recursive: true });
    const { code, body } = await runJson([]);
    expect(code).toBe(1);
    expect(body.status).toBe('unavailable');
    expect(body.matched).toBeNull();
    expect(body.requests).toEqual([]);
    const { code: textCode, out } = await run([]);
    expect(textCode).toBe(1);
    expect(out.at(-1)).toContain('unavailable');
  });

  it('renders the human view with lifecycle detail', async () => {
    seed([
      { id: 'req-answered', status: 'answered', type: 'approval', kind: 'merge-gate', text: 'Ship phantom #1?',
        options: ['hold', 'ship'], answerIndex: 1, answerText: 'ship', answeredAt: iso(NOW - 100), sentAt: iso(NOW - 200) },
      { id: 'req-expired', status: 'expired', type: 'report', kind: 'fleet-digest', text: 'Weekly digest',
        options: [], expiredAt: iso(NOW - 50), expiredReason: 'send failed 3 times' },
    ]);
    const { code, out } = await run([]);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('answered  approval  merge-gate  req-answ  Ship phantom #1?');
    expect(text).toContain('options: 1. hold  2. ship');
    expect(text).toContain('answer: "ship" (option 2) at ' + iso(NOW - 100));
    expect(text).toContain('expired  report  fleet-digest  req-expi  Weekly digest');
    expect(text).toContain('expired ' + iso(NOW - 50) + ' — send failed 3 times');
    expect(text).toContain('2 requests');
  });

  it('refuses bad usage with exit 2', async () => {
    seed([{ id: 'req-1', status: 'pending' }]);
    for (const args of [
      ['--status', 'bogus'],
      ['--status'],
      ['--type', 'bogus'],
      ['--kind'],
      ['--id', '--json'],
      ['--since', 'not-a-time'],
      ['--before', '--status'],
      ['--contains', '   '],
      ['--contains', 'x'.repeat(513)],
      ['--limit', '0'],
      ['--limit', '201'],
      ['--limit', 'abc'],
      ['--limit', '2', '--limit', '3'],
      ['--bogus'],
      ['positional'],
    ]) {
      const { code, err } = await run(args);
      expect(code, `args: ${args.join(' ')}`).toBe(2);
      expect(err.length, `args: ${args.join(' ')}`).toBeGreaterThan(0);
    }
  });
});
