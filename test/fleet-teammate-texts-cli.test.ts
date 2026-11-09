/**
 * RQ-PHX-TEAMMATETEXTS25: `ashlr fleet teammate-texts` lists unanswered
 * teammate iMessages and marks rowids answered. Hermetic: tmp runs dir,
 * console output spied, nothing is sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetTeammateTexts } from '../src/cli/fleet-teammate-texts.js';
import { markTeammateTextsAnswered, recordTeammateText, senderIdFor } from '../src/core/comms/imessage-teammate-inbox.js';

const HANDLE = 'teammate@example.test';
const NOW = new Date('2026-11-04T23:46:00Z');
const NOW_MS = NOW.getTime();

let runs = '';
let out: string[] = [];
let err: string[];

const file = () => join(runs, 'imessage', 'teammates.jsonl');
const run = (args: string[]) => cmdFleetTeammateTexts(['--runs-dir', runs, ...args], { now: () => NOW_MS });
const seed = (rowid: number, text: string, at: Date = NOW) =>
  recordTeammateText({ rowid, handle: HANDLE, text }, runs, at);

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'team-texts-'));
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(runs, { recursive: true, force: true }); });

describe('fleet teammate-texts', () => {
  it('lists unanswered texts oldest first with age and a waiting summary', async () => {
    seed(11, 'second', new Date(NOW_MS - 4 * 60_000));
    seed(10, 'first', new Date(NOW_MS - 30 * 60_000));
    expect(await run([])).toBe(0);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^30m {2}10 {2}imessage:[0-9a-f]{16} {2}first$/);
    expect(out[1]).toMatch(/^4m {2}11 {2}imessage:[0-9a-f]{16} {2}second$/);
    expect(out[2]).toBe('2 waiting, oldest 30m');
    expect(out.join('\n')).not.toContain(HANDLE);
  });

  it('prints 0 waiting on an empty inbox and honors --json', async () => {
    expect(await run([])).toBe(0);
    expect(out).toEqual(['0 waiting']);
    out.length = 0;
    seed(10, 'hello team');
    expect(await run(['--json'])).toBe(0);
    const json = JSON.parse(out[0]!);
    expect(json).toEqual({ v: 1, sourceState: 'healthy', texts: [
      { at: NOW.toISOString(), rowid: 10, senderId: senderIdFor(HANDLE), text: 'hello team', ageMinutes: 0 },
    ] });
    expect(out[0]).not.toContain(HANDLE);
  });

  it('filters with --since and hides answered rowids', async () => {
    seed(10, 'old', new Date(NOW_MS - 30 * 60_000));
    seed(11, 'fresh', new Date(NOW_MS - 2 * 60_000));
    expect(await run(['--since', '10'])).toBe(0);
    expect(out.slice(0, -1).map((l) => l.split('  ')[1])).toEqual(['11']);
    expect(out.at(-1)).toBe('1 waiting, oldest 2m');
    out.length = 0;
    markTeammateTextsAnswered([11], runs, NOW);
    expect(await run([])).toBe(0);
    expect(out.slice(0, -1).map((l) => l.split('  ')[1])).toEqual(['10']);
  });

  it('--answered marks rowids and prints the count, then they leave the list', async () => {
    seed(10, 'one'); seed(11, 'two');
    expect(await run(['--answered', '10,11'])).toBe(0);
    expect(out).toEqual(['marked 2 answered']);
    out.length = 0;
    expect(await run([])).toBe(0);
    expect(out).toEqual(['0 waiting']);
    out.length = 0;
    expect(await run(['--answered', '10'])).toBe(0);
    expect(out).toEqual(['marked 0 answered']);
    const ledger = readFileSync(file(), 'utf8');
    expect(ledger.match(/"answered"/g)).toHaveLength(2);
  });

  it('refuses bad arguments with exit 2 and keeps --help free of side effects', async () => {
    for (const args of [['--since', 'abc'], ['--answered', 'x'], ['--answered', '1,'], ['--bogus'], ['--json', '--json']]) {
      err = []; expect(await run(args)).toBe(2);
      expect(err[0]).toContain('Usage: ashlr fleet teammate-texts');
    }
    out.length = 0;
    expect(await cmdFleetTeammateTexts(['--help'])).toBe(0);
    expect(out[0]).toContain('Usage: ashlr fleet teammate-texts');
  });

  it('keeps a malformed ledger line out of the list but reports degraded in json', async () => {
    seed(10, 'fine');
    appendFileSync(file(), 'garbage line\n');
    expect(await run(['--json'])).toBe(0);
    const json = JSON.parse(out[0]!);
    expect(json.sourceState).toBe('degraded');
    expect(json.texts).toHaveLength(1);
  });
});
