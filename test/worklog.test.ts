import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { filterWorklog, worklog } from '../src/core/fleet/worklog.js';
import { cmdWorklog } from '../src/cli/worklog.js';

const now = Date.parse('2026-11-09T11:00:00Z');
const fixture = () => readFile(new URL('./fixtures/worklog/events.jsonl', import.meta.url), 'utf8');
afterEach(() => vi.restoreAllMocks());

describe('work log', () => {
  it('orders merged outcomes, joins launch details and counts malformed lines', async () => {
    const text = await readFile(new URL('./fixtures/worklog/jobs.jsonl', import.meta.url), 'utf8');
    const report = worklog(text, Date.parse('2026-11-09T00:00:00Z'), Date.parse('2026-11-10T00:00:00Z'));
    expect(filterWorklog(report.entries, 'phantom', 'work').map(e => e.job)).toEqual(['J1']);
    expect(filterWorklog(report.entries, 'locus', 'work')).toEqual([]);
    expect(filterWorklog(report.entries, undefined, 'fast').map(e => e.job)).toEqual(['J2']);
    expect(report.malformedLines).toBe(1);
    expect(report.entries.map(e => e.job)).toEqual(['J2', 'J1']);
    expect(report.entries[1]).toMatchObject({ repo: 'phantom', lane: 'work', model: 'model-a', openToMergeSeconds: 42 });
    expect(report.entries[0]).toMatchObject({ model: null, url: null, openToMergeSeconds: null });
  });
  it('projects every recorded event, including publishes and failed empty finishes, newest first', async () => {
    const report = worklog(await fixture(), now - 3600000, now);
    expect(report.entries.map(e => e.kind)).toEqual(['failed', 'launch', 'empty', 'launch', 'merged', 'pr', 'finished', 'launch']);
    expect(report.malformedLines).toBe(2);
    expect(report.entries[4]).toMatchObject({ job: 'PR', repo: 'phantom', lane: 'work', model: 'model-a', openToMergeSeconds: 60 });
    expect(report.entries[0]).toMatchObject({ job: 'FAILED', lane: 'fast', mergedAt: null });
  });
  it('reads jobs-ledger dialect spellings for ids, events, phases, links and stamps', () => {
    const iso = '2026-11-09T10:00:00Z';
    const report = worklog([
      JSON.stringify({ type: 'launch', job_id: 'DJ', pool: 'work', time: iso }),
      JSON.stringify({ kind: 'outcome', id: 'DJ', result: 'MERGED', html_url: 'https://github.com/ashlrai/phantom/pull/42', updatedAt: iso }),
    ].join('\n'), now - 7200000, now);
    const merged = report.entries.find(e => e.kind === 'merged');
    expect(merged).toMatchObject({ job: 'DJ', url: 'https://github.com/ashlrai/phantom/pull/42', mergedAt: iso });
    expect(report.malformedLines).toBe(0);
  });
  it('filters each lane, repo and time boundary, including combined filters', async () => {
    const entries = worklog(await fixture(), now - 3600000, now).entries;
    expect(filterWorklog(entries, 'locus').map(e => e.kind)).toEqual(['empty', 'launch']);
    expect(filterWorklog(entries, undefined, 'fast')).toHaveLength(4);
    expect(filterWorklog(entries, 'phantom', 'fast').map(e => e.kind)).toEqual(['failed', 'launch']);
    expect(worklog(await fixture(), Date.parse('2026-11-09T10:11:00Z'), now).entries.map(e => e.kind)).toEqual(['failed']);
  });
  it('does not borrow future launch metadata or hide a publish behind a merge', async () => {
    const text = await fixture();
    const repeated = text + '\n' + JSON.stringify({ event: 'launch', job: 'PR', lane: 'later', ts: '2026-11-09T10:06:30Z' });
    expect(worklog(repeated, 0, now).entries.filter(e => e.job === 'PR' && e.kind !== 'launch').map(e => e.lane)).toEqual(['work', 'work', 'work']);
    const url = 'https://github.com/ashlrai/phantom/pull/3';
    const duplicate = JSON.stringify({ event: 'outcome', state: 'MERGED', url, ts: '2026-11-09T10:07:00Z' });
    const entries = worklog(text + '\n' + duplicate, 0, now).entries;
    expect(entries.filter(e => e.url === url).map(e => e.kind)).toEqual(['merged', 'pr']);
  });
  it('ignores invalid JSON values and unsafe PR links, and leaves unknown finishes unknown', () => {
    const report = worklog('null\n[]\n' + JSON.stringify({ event: 'finish', ts: '2026-11-09T10:00:00Z', url: 'javascript:alert(1)' }), 0, now);
    expect(report.malformedLines).toBe(2);
    expect(report.entries[0]).toMatchObject({ kind: 'finished', url: null, lane: null });
    expect(worklog('', 0, now).entries).toEqual([]);
  });
  it('serves filtered JSON and passes --since to the reader', async () => {
    const read = vi.fn(async () => worklog(await fixture(), 0, now));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdWorklog(['--json', '--since', '1h', '--repo', 'phantom', '--lane', 'fast'], read)).toBe(0);
    expect(read).toHaveBeenCalledWith(1);
    expect(JSON.parse(output.mock.calls[0][0]).entries.map((e: { kind: string }) => e.kind)).toEqual(['failed', 'launch']);
  });
  it.each([['--lane'], ['--repo', '--json'], ['--lane', ' '], ['--since'], ['--since', '0h'], ['--since', 'bad'], ['--unknown']])('rejects invalid CLI arguments %j', async (...args) => {
    const read = vi.fn(); vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdWorklog(args, read)).toBe(2); expect(read).not.toHaveBeenCalled();
  });
  it('prints an empty state and reports read failure without private details', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdWorklog([], async () => worklog('', 0, now))).toBe(0);
    expect(output).toHaveBeenCalledWith('No work recorded in the last 6 hours.');
    expect(await cmdWorklog(['--lane', 'none'], async () => worklog('', 0, now))).toBe(0);
    expect(output).toHaveBeenLastCalledWith('No work events match these filters.');
    expect(await cmdWorklog(['--json'], async () => { throw new Error('private path'); })).toBe(1);
    expect(error).toHaveBeenCalledWith('Unable to read the work log.');
  });
});
