import { Readable } from 'node:stream';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJobHistoryBatch, JOB_STDIN_MAX_BYTES, type JobIdStdin } from '../src/cli/fleet-job-history-batch.js';

// The git reader boundary: every test asserts on this mock, never on real git.
const reader = vi.hoisted(() => ({ jobHistoryBatch: vi.fn() }));
vi.mock('../src/core/fleet/job-history-batch.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fleet/job-history-batch.js')>(),
  jobHistoryBatch: reader.jobHistoryBatch,
}));

const OID = 'f'.repeat(40);
const sha = (n: number) => n.toString(16).padStart(40, '0');

/** Canned reader result: id order preserved, first id truncated, second id empty, third id one commit. */
const fakeResult = (ids: string[], limit: number) => ({
  resolvedRef: OID, scanBound: 1000, scanned: 3, scanMayBeTruncated: false, limit,
  jobs: ids.map((jobId, i) => ({
    jobId,
    matchesTruncated: i === 0,
    commits: i === 1 ? [] : [{ sha: sha(i + 1), date: `d${i}`, pr: 40 + i, paths: [`p/${i}.ts`] }],
    paths: i === 1 ? [] : [`p/${i}.ts`],
  })),
});

const pipe = (...chunks: Array<string | Buffer>): JobIdStdin => Readable.from(
  chunks.map(chunk => typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk),
);

/** Endless source that counts pulls and records when the consumer closed it. */
function endless(state: { pulled: number; closed: boolean }): JobIdStdin {
  return (async function* () {
    try {
      for (;;) { state.pulled++; yield Buffer.alloc(1024, 0x20); }
    } finally { state.closed = true; }
  })();
}

let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reader.jobHistoryBatch.mockReset();
  reader.jobHistoryBatch.mockImplementation(async (ids: string[], limit: number) => fakeResult(ids, limit));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => { vi.restoreAllMocks(); });

it('sends one valid piped batch to exactly one reader call, keeping id order and immutable evidence', async () => {
  const code = await cmdFleetJobHistoryBatch(['--stdin', '--json'], pipe('["RQ-BBB-2", "RQ-AAA-1", "RQ-CCC-3"]\n'));
  expect(code).toBe(0);
  expect(reader.jobHistoryBatch).toHaveBeenCalledTimes(1);
  expect(reader.jobHistoryBatch).toHaveBeenCalledWith(['RQ-BBB-2', 'RQ-AAA-1', 'RQ-CCC-3'], 20);
  const out = JSON.parse(log.mock.calls.at(-1)![0] as string);
  expect(out.resolvedRef).toBe(OID);
  expect(out.jobs.map((job: { jobId: string }) => job.jobId)).toEqual(['RQ-BBB-2', 'RQ-AAA-1', 'RQ-CCC-3']);
  expect(out.jobs[0]).toMatchObject({ matchesTruncated: true });
  expect(out.jobs[1]).toMatchObject({ matchesTruncated: false, commits: [], paths: [] });
  expect(out.jobs[2].commits[0]).toMatchObject({ pr: 42, paths: ['p/2.ts'] });
  expect(error).not.toHaveBeenCalled();
});

it('passes --limit through and prints the same text evidence as positional mode', async () => {
  expect(await cmdFleetJobHistoryBatch(['--limit', '5', '--stdin'], pipe('["RQ-AAA-1"]'))).toBe(0);
  expect(reader.jobHistoryBatch).toHaveBeenLastCalledWith(['RQ-AAA-1'], 5);
  expect(log.mock.calls[0]![0]).toContain(`Resolved origin/master to ${OID}`);
  expect(log.mock.calls.map(call => String(call[0])).join('\n')).toContain('matching commits exceed the result limit');
});

it('accepts exactly twenty distinct ids from stdin', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `RQ-JOB-${i}`);
  expect(await cmdFleetJobHistoryBatch(['--stdin', '--json'], pipe(JSON.stringify(ids)))).toBe(0);
  expect(reader.jobHistoryBatch).toHaveBeenCalledWith(ids, 20);
});

it('keeps positional usage working with the same reader call and JSON output', async () => {
  expect(await cmdFleetJobHistoryBatch(['RQ-BBB-2', 'RQ-AAA-1', '--json'])).toBe(0);
  expect(reader.jobHistoryBatch).toHaveBeenCalledTimes(1);
  expect(reader.jobHistoryBatch).toHaveBeenCalledWith(['RQ-BBB-2', 'RQ-AAA-1'], 20);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string).resolvedRef).toBe(OID);
});

it('rejects mixed id sources and repeated or unknown flags before reading stdin or calling git', async () => {
  for (const args of [
    ['RQ-A', '--stdin'], ['--stdin', 'RQ-A'], ['--stdin', 'RQ-A', '--json'],
    ['--stdin', '--stdin'], ['--stdin', '--json', '--json'],
    ['--stdin', '--bogus'], ['--stdin', '--limit', '0'], ['--stdin', '--limit'], ['--stdin', '-h'],
    ['--stdin', '--help'], ['--stdin', '--ref', 'HEAD'],
  ]) {
    const state = { pulled: 0, closed: false };
    expect(await cmdFleetJobHistoryBatch(args, endless(state))).toBe(2);
    expect(state.pulled).toBe(0);
  }
  expect(reader.jobHistoryBatch).not.toHaveBeenCalled();
  expect(error.mock.calls.at(-1)![0]).toContain('--stdin');
});

it('rejects malformed, non-array, empty, oversized-array, duplicate and invalid-id input with usage 2 and no git call', async () => {
  const twentyOne = JSON.stringify(Array.from({ length: 21 }, (_, i) => `RQ-JOB-${i}`));
  for (const input of [
    '', '   ', 'RQ-AAA-1', '{"ids":["RQ-AAA-1"]}', '"RQ-AAA-1"', '[]', twentyOne,
    '["RQ-AAA-1",]', '["RQ-AAA-1"] trailing', '["RQ-AAA-1"][0]',
    '[1]', '[null]', '[["RQ-AAA-1"]]', '[{"id":"RQ-AAA-1"}]', '[true]',
    '["nope"]', '["rq-aaa-1"]', '["RQ-"]', '["RQ-A B"]', '[""]', '["--json"]', '["RQ-AAA-1/../x"]',
    '["RQ-AAA-1","RQ-AAA-1"]',
  ]) {
    expect(await cmdFleetJobHistoryBatch(['--stdin'], pipe(input))).toBe(2);
  }
  expect(reader.jobHistoryBatch).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
});

it('rejects invalid UTF-8 with usage 2 and no git call', async () => {
  expect(await cmdFleetJobHistoryBatch(['--stdin'], pipe(Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d])))).toBe(2);
  expect(await cmdFleetJobHistoryBatch(['--stdin'], pipe(Buffer.from('["RQ-AAA-1\xc3"]', 'latin1')))).toBe(2);
  expect(reader.jobHistoryBatch).not.toHaveBeenCalled();
});

it('never echoes raw stdin content in errors', async () => {
  expect(await cmdFleetJobHistoryBatch(['--stdin'], pipe('["RQ-AAA-1", "SECRET-PROBE-771"]'))).toBe(2);
  expect(await cmdFleetJobHistoryBatch(['--stdin'], pipe('SECRET-PROBE-772 not json'))).toBe(2);
  const printed = [...error.mock.calls, ...log.mock.calls].map(call => String(call[0])).join('\n');
  expect(printed).not.toContain('SECRET-PROBE');
  expect(printed).toContain('Usage: ashlr fleet job-history-batch');
});

it('stops reading an oversized stream as soon as it passes the 64 KiB bound', async () => {
  const state = { pulled: 0, closed: false };
  expect(await cmdFleetJobHistoryBatch(['--stdin'], endless(state))).toBe(2);
  // 64 full 1 KiB chunks fit exactly; the 65th crosses the bound and is never buffered past it.
  expect(JOB_STDIN_MAX_BYTES).toBe(65_536);
  expect(state.pulled).toBe(65);
  expect(state.closed).toBe(true);
  expect(reader.jobHistoryBatch).not.toHaveBeenCalled();
});

it('accepts input of exactly 64 KiB and rejects one byte more', async () => {
  const body = JSON.stringify(['RQ-AAA-1']);
  const padded = (size: number) => body.slice(0, -1) + ' '.repeat(size - body.length) + ']';
  expect(await cmdFleetJobHistoryBatch(['--stdin'], pipe(padded(JOB_STDIN_MAX_BYTES)))).toBe(0);
  expect(reader.jobHistoryBatch).toHaveBeenCalledTimes(1);
  expect(await cmdFleetJobHistoryBatch(['--stdin'], pipe(padded(JOB_STDIN_MAX_BYTES + 1)))).toBe(2);
  expect(reader.jobHistoryBatch).toHaveBeenCalledTimes(1);
});

it('returns a concise nonzero result on a stream error, never empty evidence', async () => {
  const failing = (async function* () {
    yield Buffer.from('["RQ-AAA-1"', 'utf8');
    throw new Error('EIO: /private/fake/stdin-path');
  })();
  expect(await cmdFleetJobHistoryBatch(['--stdin', '--json'], failing)).toBe(1);
  expect(error).toHaveBeenCalledWith('error: unable to read job ids from stdin');
  expect(reader.jobHistoryBatch).not.toHaveBeenCalled();
  const printed = [...error.mock.calls, ...log.mock.calls].map(call => String(call[0])).join('\n');
  expect(printed).not.toContain('/private/fake');
  expect(log).not.toHaveBeenCalled();
});

it('--help and -h print usage without consuming stdin', async () => {
  for (const args of [['--help'], ['-h']]) {
    const state = { pulled: 0, closed: false };
    expect(await cmdFleetJobHistoryBatch(args, endless(state))).toBe(0);
    expect(state.pulled).toBe(0);
  }
  expect(log.mock.calls.at(-1)![0]).toContain('--stdin');
  expect(reader.jobHistoryBatch).not.toHaveBeenCalled();
});

it('reports a git reader failure as an error rather than empty evidence', async () => {
  reader.jobHistoryBatch.mockRejectedValue(new Error('fatal: not a git repository'));
  expect(await cmdFleetJobHistoryBatch(['--stdin'], pipe('["RQ-AAA-1"]'))).toBe(1);
  expect(error).toHaveBeenCalledWith('error: unable to read job history batch from git');
  expect(log).not.toHaveBeenCalled();
});
