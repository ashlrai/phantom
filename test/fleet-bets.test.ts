import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBets, defaultFleetBetsReaders, parseTs, readBets } from '../src/cli/fleet-bets.js';

const fixtures = resolve(__dirname, 'fixtures/fleet-bets');
const readers = defaultFleetBetsReaders(fixtures);
afterEach(() => vi.restoreAllMocks());

it('reports each READY bet once, with the right status, from fixture files', async () => {
  const report = readBets(await readers.vision(), await readers.jobs(3000));
  expect(report.bets.map(({ id, status }) => [id, status])).toEqual([
    ['RQ-MERGEDQ8', 'merged'], ['RQ-OPENQ8', 'PR open'], ['RQ-RUNQ8', 'launched'],
    ['RQ-SKIPQ8', 'skipped'], ['RQ-EMPTYQ8', 'empty'], ['RQ-NEWQ8', 'not seen'],
  ]);
  expect(report).toMatchObject({ merged: 1, total: 6 });
  expect(report.bets[0]).toMatchObject({ lane: 'codex', model: 'gpt-x', ttm_s: 1800, url: 'https://github.com/ashlrai/phantom/pull/1' });
  expect(report.bets[1]!.url).toBe('https://github.com/ashlrai/phantom/pull/2');
  expect(report.bets[3]).toMatchObject({ precheck_code: 42 });
});

it('accepts ts offsets with and without a colon, and lets the newest row win', () => {
  expect(parseTs('2026-11-03T10:00:00-0500')).toBe(Date.parse('2026-11-03T15:00:00Z'));
  expect(parseTs('2026-11-03T10:00:00+05:30')).toBe(Date.parse('2026-11-03T04:30:00Z'));
  expect(parseTs('nope')).toBeNaN();
  const rows = [
    { event: 'outcome', job: 'RQ-AQ8', state: 'MERGED', ttm_s: 5, ts: '2026-11-03T10:00:00-0500' }, // 15:00Z
    { event: 'outcome', job: 'RQ-AQ8', state: 'OPEN', ts: '2026-11-03T11:00:00+0000' }, // 11:00Z, older
  ].map(r => JSON.stringify(r)).join('\n');
  expect(readBets('- READY RQ-AQ8', rows).bets[0]).toMatchObject({ status: 'merged', ttm_s: 5 });
});

it('reads only the last 3000 lines and treats missing files as not seen', async () => {
  const old = JSON.stringify({ event: 'launch', job: 'RQ-OLDQ8', lane: 'x' });
  const filler = JSON.stringify({ event: 'launch', job: 'RQ-OTHERQ8' });
  const ledger = [old, ...Array(3000).fill(filler)].join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-bets-'));
  mkdirSync(join(dir, 'metrics'));
  writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), ledger);
  const tail = await defaultFleetBetsReaders(dir).jobs(3000);
  expect(tail!.split('\n')).toHaveLength(3000);
  expect(readBets('- READY RQ-OLDQ8', tail).bets[0]!.status).toBe('not seen');
  expect(readBets('- READY RQ-OLDQ8', [old, ...Array(2999).fill(filler)].join('\n')).bets[0]!.status).toBe('launched');
  expect(await defaultFleetBetsReaders(join(dir, 'missing')).vision()).toBeNull();
  expect(readBets(null, null)).toMatchObject({ merged: 0, total: 0, bets: [] });
});

it('prints the total first in plain words, and JSON with --json', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBets([], readers)).toBe(0);
  const lines = String(log.mock.calls[0]![0]).split('\n');
  expect(lines[0]).toBe('merged 1 of 6');
  expect(lines).toContain('RQ-MERGEDQ8: merged (1800s to merge)');
  expect(lines).toContain('RQ-OPENQ8: PR open (https://github.com/ashlrai/phantom/pull/2)');
  expect(lines).toContain('RQ-RUNQ8: launched (codex, gpt-x)');
  expect(lines).toContain('RQ-SKIPQ8: skipped (precheck 42)');
  expect(lines).toContain('RQ-NEWQ8: not seen');
  log.mockClear();
  expect(await cmdFleetBets(['--json'], readers)).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ schema: 'fleet.bets.v1', merged: 1, total: 6 });
});

it('rejects extra arguments and survives unreadable files', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetBets(['--wat'], readers)).toBe(2);
  expect(await cmdFleetBets([], { vision: async () => { throw new Error('boom'); }, jobs: async () => null })).toBe(1);
  expect(err).toHaveBeenCalledTimes(2);
});
