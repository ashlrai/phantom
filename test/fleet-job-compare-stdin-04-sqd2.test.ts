import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetJobCompare } from '../src/cli/fleet-job-compare.js';
import type { JobCompareReport } from '../src/core/fleet/job-compare.js';

const report = { caveat: 'evidence only', jobs: [], comparable: false, unmatched: [] } as unknown as JobCompareReport;
const bytes = (value: string) => Buffer.from(value);
async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}

afterEach(() => vi.restoreAllMocks());

describe('fleet job-compare stdin', () => {
  it('passes a piped pair once and emits the same JSON as positional input', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const compare = vi.fn().mockResolvedValue(report);
    expect(await cmdFleetJobCompare(['--stdin', '--json'], {
      stdin: chunks(bytes('["RQ-A",'), bytes('"RQ-B"]')), compare,
    })).toBe(0);
    expect(compare).toHaveBeenCalledExactlyOnceWith('RQ-A', 'RQ-B');
    const output = log.mock.calls[0];
    expect(await cmdFleetJobCompare(['RQ-A', 'RQ-B', '--json'], { compare })).toBe(0);
    expect(log.mock.calls[1]).toEqual(output);
  });

  it.each(['invalid', '["RQ-A", "RQ-A"]', '["RQ-A", "RQ-B", "RQ-C"]', '["RQ-A", 2]', '["bad", "RQ-B"]', '["RQ-A", "RQ-B"'])
  ('rejects invalid input %s without comparison', async input => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const compare = vi.fn();
    expect(await cmdFleetJobCompare(['--stdin'], { stdin: chunks(bytes(input)), compare })).toBe(2);
    expect(compare).not.toHaveBeenCalled();
  });

  it('enforces the byte cap incrementally across chunk boundaries', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const compare = vi.fn().mockResolvedValue(report);
    const pair = '["RQ-A","RQ-B"]';
    const padding = ' '.repeat(16384 - Buffer.byteLength(pair));
    expect(await cmdFleetJobCompare(['--stdin', '--json'], {
      stdin: chunks(bytes(pair), bytes(padding)), compare,
    })).toBe(0);
    compare.mockClear();
    let continued = false;
    async function* oversized() {
      yield bytes(pair + padding);
      yield bytes(' ');
      continued = true;
      yield bytes(' ');
    }
    expect(await cmdFleetJobCompare(['--stdin'], { stdin: oversized(), compare })).toBe(2);
    expect(compare).not.toHaveBeenCalled();
    expect(continued).toBe(false);
  });

  it.each([['--stdin', 'RQ-A', 'RQ-B'], ['--stdin', '--stdin'], ['--stdin', '--json', '--json']])
  ('rejects conflicting arguments %j before reading', async (...args) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const compare = vi.fn();
    async function* fail() { throw new Error('must not read'); yield bytes(''); }
    expect(await cmdFleetJobCompare(args, { stdin: fail(), compare })).toBe(2);
    expect(compare).not.toHaveBeenCalled();
  });

  it('does not read stdin for help and sanitizes reader errors', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const compare = vi.fn();
    async function* fail() { throw new Error('sensitive detail'); yield bytes(''); }
    expect(await cmdFleetJobCompare(['--help'], { stdin: fail(), compare })).toBe(0);
    expect(await cmdFleetJobCompare(['--stdin'], { stdin: fail(), compare })).toBe(1);
    expect(error).toHaveBeenCalledWith('error: unable to compare jobs from git');
    expect(compare).not.toHaveBeenCalled();
  });
});
