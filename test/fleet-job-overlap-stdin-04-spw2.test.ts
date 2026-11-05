import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJobOverlap, type FleetJobOverlapDeps } from '../src/cli/fleet-job-overlap.js';
import { JOB_BATCH_MAX } from '../src/core/fleet/job-history-batch.js';
import { type JobOverlapResult } from '../src/core/fleet/job-overlap.js';

type Input = Readable & { isTTY?: boolean };
const STDIN_MAX_BYTES = 16 * 1024;
const OID = 'f'.repeat(40);

afterEach(() => vi.restoreAllMocks());

/** Fake ordinary result shape; ids and limit are echoed so the test can see what the reader received. */
const fakeResult = (ids: string[], limit: number): JobOverlapResult => ({
  schemaVersion: 1, ref: 'origin/master', resolvedRef: OID, scanBound: 1000, scanned: 2,
  scanMayBeTruncated: false, limit, evidenceMayBeIncomplete: false,
  jobs: ids.map(jobId => ({ jobId, commits: 1, paths: 1, matchesTruncated: false })),
  sharedPaths: [{ path: 'shared/one.ts', jobIds: ids }],
  note: 'fake note',
});

/** A piped stream that delivers the given chunks and then ends. */
function piped(...chunks: Array<string | Buffer>): Input {
  const stream = new PassThrough();
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  return stream;
}

/** A piped stream that never reaches end-of-input. */
const stalled = (): Input => new PassThrough();

const tty = (): Input => Object.assign(new PassThrough(), { isTTY: true });

function capture() {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
}

const overlapSpy = () => vi.fn(async (ids: string[], limit: number) => fakeResult(ids, limit));

/** Runs the command with an explicit stdin; never falls back to the host stdin. */
const run = (args: string[], input: Input, deps: Partial<FleetJobOverlapDeps> = {}) =>
  cmdFleetJobOverlap(args, { input, ...deps });

it('streams a valid array into the existing overlap reader once, in order, with the requested limit', async () => {
  const { log, error } = capture();
  const overlap = overlapSpy();
  const code = await run(['--stdin', '--limit', '7', '--json'], piped('["RQ-B-2",', '"RQ-A-1"]'), { overlap });
  expect(code).toBe(0);
  expect(overlap).toHaveBeenCalledTimes(1);
  expect(overlap).toHaveBeenCalledWith(['RQ-B-2', 'RQ-A-1'], 7);
  expect(error).not.toHaveBeenCalled();
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual(fakeResult(['RQ-B-2', 'RQ-A-1'], 7));
});

it('prints the ordinary human report for streamed ids and defaults the limit to 20', async () => {
  const { log } = capture();
  const overlap = overlapSpy();
  expect(await run(['--stdin'], piped('["RQ-A-1","RQ-B-2"]'), { overlap })).toBe(0);
  expect(overlap).toHaveBeenCalledWith(['RQ-A-1', 'RQ-B-2'], 20);
  const lines = log.mock.calls.map(call => String(call[0]));
  expect(lines[0]).toBe('Resolved origin/master to ' + OID + '; scanned 2 commits (bound 1000; history exhausted).');
  expect(lines).toContain('  shared/one.ts: RQ-A-1, RQ-B-2');
});

it('accepts an exact-limit array padded with whitespace, and rejects one byte more', async () => {
  const base = '["RQ-A-1","RQ-B-2"]';
  const overlap = overlapSpy();
  capture();
  const atLimit = Buffer.from(base + ' '.repeat(STDIN_MAX_BYTES - base.length));
  expect(await run(['--stdin', '--json'], piped(atLimit), { overlap })).toBe(0);
  expect(overlap).toHaveBeenCalledTimes(1);

  const { error } = capture();
  const overLimit = Buffer.from(base + ' '.repeat(STDIN_MAX_BYTES - base.length + 1));
  const overlapOver = overlapSpy();
  expect(await run(['--stdin'], piped(overLimit), { overlap: overlapOver })).toBe(2);
  expect(overlapOver).not.toHaveBeenCalled();
  expect(error.mock.calls[0]![0]).toBe(`error: input exceeds ${STDIN_MAX_BYTES} bytes`);
});

it('bounds multibyte input by bytes across chunks that split code points', async () => {
  // 8200 two-byte characters: 8200 chars is far under 16 KiB, but 16400 bytes is over it.
  const text = '["RQ-A-1","' + 'é'.repeat(8200) + '"]';
  const bytes = Buffer.from(text);
  expect(bytes.byteLength).toBeGreaterThan(STDIN_MAX_BYTES);
  const chunks: Buffer[] = [];
  for (let at = 0; at < bytes.byteLength; at += 1001) chunks.push(bytes.subarray(at, at + 1001));
  const { error } = capture();
  const overlap = overlapSpy();
  expect(await run(['--stdin'], piped(...chunks), { overlap })).toBe(2);
  expect(overlap).not.toHaveBeenCalled();
  expect(error.mock.calls[0]![0]).toBe(`error: input exceeds ${STDIN_MAX_BYTES} bytes`);
});

it('rejects excess input promptly, without waiting for end-of-input', async () => {
  capture();
  const overlap = overlapSpy();
  const input = stalled();
  // A 60 s deadline would fail this test's 5 s budget if the reader waited for end-of-input.
  const result = run(['--stdin'], input, { overlap, inputTimeoutMs: 60_000 });
  input.write(Buffer.alloc(STDIN_MAX_BYTES + 1, 0x20));
  expect(await result).toBe(2);
  expect(overlap).not.toHaveBeenCalled();
  expect(input.isPaused()).toBe(true);
});

it('refuses a stalled stream at the input deadline and never calls the reader', async () => {
  const { error } = capture();
  const overlap = overlapSpy();
  expect(await run(['--stdin'], stalled(), { overlap, inputTimeoutMs: 10 })).toBe(2);
  expect(overlap).not.toHaveBeenCalled();
  expect(error.mock.calls[0]![0]).toBe('error: input did not reach end-of-input in time');
});

it('reports a stream failure as an input refusal and never calls the reader', async () => {
  const { error } = capture();
  const overlap = overlapSpy();
  const input = stalled();
  const result = run(['--stdin'], input, { overlap, inputTimeoutMs: 60_000 });
  input.destroy(new Error('synthetic read failure'));
  expect(await result).toBe(2);
  expect(overlap).not.toHaveBeenCalled();
  expect(error.mock.calls[0]![0]).toBe('error: stdin could not be read');
  expect(error.mock.calls.flat().join('\n')).not.toContain('synthetic read failure');
});

it('refuses interactive input before any read', async () => {
  const { error } = capture();
  const overlap = overlapSpy();
  expect(await run(['--stdin'], tty(), { overlap })).toBe(2);
  expect(overlap).not.toHaveBeenCalled();
  expect(error.mock.calls[0]![0]).toBe('error: stdin must be piped; interactive input is refused');
});

it('refuses malformed JSON, nonarrays, nonstrings, duplicates and invalid ids without echoing input', async () => {
  const cases: Array<[string, string]> = [
    ['["RQ-A-1","RQ-B-2"', 'malformed'],
    ['not json RQ-SECRETISH-1', 'malformed'],
    ['{"ids":["RQ-A-1","RQ-B-2"]}', 'object'],
    ['"RQ-A-1"', 'string'],
    ['null', 'null'],
    ['["RQ-A-1",2]', 'number'],
    ['["RQ-A-1",null]', 'null entry'],
    ['[["RQ-A-1"],"RQ-B-2"]', 'nested array'],
    ['["RQ-A-1","RQ-A-1"]', 'duplicate'],
    ['["rq-a-1","RQ-B-2"]', 'lowercase'],
    ['["RQ-A B","RQ-B-2"]', 'space'],
    ['["RQ-A-1","nope"]', 'missing prefix'],
    ['["RQ-A-1"," RQ-B-2"]', 'padded entry'],
    ['["RQ-A-1","RQ-A-1\\u0000"]', 'nul'],
  ];
  for (const [text] of cases) {
    const { error } = capture();
    const overlap = overlapSpy();
    expect(await run(['--stdin'], piped(text), { overlap })).toBe(2);
    expect(overlap).not.toHaveBeenCalled();
    // Refusals name the rule only; raw input and parser text never reach stderr.
    const printed = error.mock.calls.flat().join('\n');
    expect(printed).toContain('error: ');
    expect(printed).not.toContain('RQ-SECRETISH');
    expect(printed).not.toContain('Unexpected');
    expect(printed).not.toContain('JSON.parse');
    vi.restoreAllMocks();
  }
});

it('refuses invalid UTF-8 without a parser or decoder message', async () => {
  const { error } = capture();
  const overlap = overlapSpy();
  expect(await run(['--stdin'], piped(Buffer.from([0x5b, 0xff, 0x5d])), { overlap })).toBe(2);
  expect(overlap).not.toHaveBeenCalled();
  expect(error.mock.calls[0]![0]).toBe('error: input must be a UTF-8 JSON array');
});

it('refuses empty, single and oversized id lists, and any list over JOB_BATCH_MAX', async () => {
  const many = Array.from({ length: JOB_BATCH_MAX + 1 }, (_, i) => `RQ-N-${i}`);
  const full = Array.from({ length: JOB_BATCH_MAX }, (_, i) => `RQ-N-${i}`);
  const sized = [
    ['[]', 'empty'],
    ['["RQ-A-1"]', 'single'],
    [JSON.stringify(many), 'too many'],
  ] as const;
  for (const [text] of sized) {
    const { error } = capture();
    const overlap = overlapSpy();
    expect(await run(['--stdin'], piped(text), { overlap })).toBe(2);
    expect(overlap).not.toHaveBeenCalled();
    expect(error.mock.calls[0]![0]).toBe(`error: input must list 2 to ${JOB_BATCH_MAX} job ids`);
  }
  // The maximum is accepted and reaches the reader in order.
  capture();
  const overlap = overlapSpy();
  expect(await run(['--stdin', '--json'], piped(JSON.stringify(full)), { overlap })).toBe(0);
  expect(overlap).toHaveBeenCalledWith(full, 20);
});

it('refuses --stdin mixed with positional ids in either order, and repeated --stdin', async () => {
  for (const args of [['--stdin', 'RQ-A-1'], ['RQ-A-1', '--stdin'], ['--stdin', '--stdin'], ['--stdin', 'RQ-A-1', '--stdin']]) {
    const { error } = capture();
    const overlap = overlapSpy();
    // A stream that never ends would hang the test if the reader were called.
    expect(await run(args, stalled(), { overlap, inputTimeoutMs: 60_000 })).toBe(2);
    expect(overlap).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  }
});

it('refuses bad --limit values in stdin mode before reading input', async () => {
  for (const args of [['--stdin', '--limit', '0'], ['--stdin', '--limit', '101'], ['--stdin', '--limit'], ['--stdin', '--bogus']]) {
    capture();
    const overlap = overlapSpy();
    expect(await run(args, stalled(), { overlap, inputTimeoutMs: 60_000 })).toBe(2);
    expect(overlap).not.toHaveBeenCalled();
  }
});

it('keeps positional mode unchanged and never reads stdin', async () => {
  const { log } = capture();
  const overlap = overlapSpy();
  // A stalled stream would fail the 5 s budget if positional mode read it.
  expect(await run(['RQ-B-2', 'RQ-A-1', '--limit', '5', '--json'], stalled(), { overlap, inputTimeoutMs: 60_000 })).toBe(0);
  expect(overlap).toHaveBeenCalledTimes(1);
  expect(overlap).toHaveBeenCalledWith(['RQ-B-2', 'RQ-A-1'], 5);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual(fakeResult(['RQ-B-2', 'RQ-A-1'], 5));
  // Positional validation still refuses before the reader.
  for (const args of [['RQ-A-1'], ['RQ-A-1', 'RQ-A-1'], ['RQ-A-1', '--bogus', 'RQ-B-2']]) {
    const reader = overlapSpy();
    expect(await run(args, stalled(), { overlap: reader, inputTimeoutMs: 60_000 })).toBe(2);
    expect(reader).not.toHaveBeenCalled();
  }
});

it('never calls git for invalid stdin, even without an injected reader', async () => {
  // Outside any repository the real reader would fail with exit 1; invalid input must exit 2 first.
  const cwd = process.cwd();
  const { error } = capture();
  const dir = mkdtempSync(join(tmpdir(), 'job-overlap-stdin-nogit-'));
  try {
    process.chdir(dir);
    expect(await cmdFleetJobOverlap(['--stdin'], { input: piped('["RQ-A-1"]') })).toBe(2);
    expect(await cmdFleetJobOverlap(['--stdin'], { input: tty() })).toBe(2);
    expect(error.mock.calls.some(call => String(call[0]).includes('unable to read job overlap'))).toBe(false);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
