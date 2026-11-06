import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReassignStdin } from '../src/cli/fleet-reassign-stdin.js';
import { reassignQueuedJobs, type ReassignInput, type ReassignOptions, type ReassignReportV1 } from '../src/core/fleet/runs-reassign.js';

let runsDir: string;
let queueDir: string;
let readyPath: string;
let logPath: string;
let output: string[];
let errors: string;

const NOW = new Date('2026-11-01T00:00:00Z');
const prompt = (id: string) => `${queueDir}/prompts/${id}.md`;
const row = (id: string, lane: string, tier = 'work', repo = 'phantom', extra = '') =>
  `${id}\t${repo}\t${lane}\t${tier}\t${prompt(id)}${extra}`;
const fixture = () => [
  row('RQ-PHX-FAKEONE01', 'codex-personal'),
  row('RQ-PHX-FAKETWO02', 'codex-personal', 'mid'),
  row('RQ-PHX-LAUNCHED9', 'codex-personal'),
  row('RQ-PHX-EXTRA005', 'codex-personal', 'work', 'phantom', '\tkeepme'),
  row('RQ-PHX-UNSELEC06', 'codex-personal'),
].join('\n') + '\n';
const ready = async () => (await readFile(readyPath, 'utf8')).split('\n').filter(Boolean);
const logRows = async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean);

/** The real core with the verify wait shrunk to nothing; the spy records every call. */
const realCore = (input: ReassignInput, opts: ReassignOptions): Promise<ReassignReportV1> =>
  reassignQueuedJobs(input, { ...opts, now: () => NOW, verifyMs: 0, sleep: async () => {} });

/** A finished byte stream, so the reader sees Buffer chunks exactly as process.stdin would deliver them. */
const stream = (text: string): PassThrough => {
  const piped = new PassThrough();
  piped.end(text);
  return piped;
};

async function run(args: string[], input: Readable & { isTTY?: boolean }, deps: { reassign?: typeof realCore; inputTimeoutMs?: number } = {}) {
  const reassign = vi.fn(deps.reassign ?? realCore);
  const code = await cmdFleetReassignStdin(args, { input, reassign, ...(deps.inputTimeoutMs !== undefined ? { inputTimeoutMs: deps.inputTimeoutMs } : {}) });
  return { code, reassign };
}
const json = () => JSON.parse(output.at(-1)!);

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'reassign-stdin-'));
  queueDir = join(runsDir, 'queue');
  await mkdir(join(queueDir, 'prompts'), { recursive: true });
  readyPath = join(queueDir, 'ready.tsv');
  logPath = join(queueDir, 'reassign.log');
  await writeFile(readyPath, fixture());
  await writeFile(join(queueDir, 'slots.json'), JSON.stringify({ lanes: {
    'codex-personal': { target: 1, floor: 0, ceiling: 4, held: false },
    devin: { target: 2, floor: 0, ceiling: 6, held: false },
    'held-lane': { target: 0, floor: 0, ceiling: 2, held: true, held_reason: 'fake hold', held_by: 'autobackoff' },
  } }));
  await writeFile(join(queueDir, 'claude-lane.state'), 'up fake healthy\n');
  await writeFile(join(runsDir, 'RQ-PHX-LAUNCHED9.launch'), 'launched RQ-PHX-LAUNCHED9 codex-personal pid 42 base fake');
  output = []; errors = '';
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors += String(chunk); return true; });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(runsDir, { recursive: true, force: true });
});

describe('fleet reassign-stdin: selection and writes', () => {
  it('moves only the selected rows and keeps prompt paths and extra columns', async () => {
    const before = await ready();
    const { code, reassign } = await run(
      ['--lane', 'devin', '--apply', '--runs-dir', runsDir, '--json'],
      stream('RQ-PHX-FAKEONE01\nRQ-PHX-EXTRA005\n'));
    expect(code).toBe(0);
    expect(reassign).toHaveBeenCalledTimes(2);
    const after = await ready();
    expect(after).toEqual([
      row('RQ-PHX-FAKEONE01', 'devin'),
      before[1],
      before[2],
      row('RQ-PHX-EXTRA005', 'devin', 'work', 'phantom', '\tkeepme'),
      before[4],
    ]);
    expect(await logRows()).toEqual([
      `${NOW.toISOString()}\tRQ-PHX-FAKEONE01\tcodex-personal\tdevin\tashlr fleet reassign-stdin\t`,
      `${NOW.toISOString()}\tRQ-PHX-EXTRA005\tcodex-personal\tdevin\tashlr fleet reassign-stdin\t`,
    ]);
    expect(json()).toMatchObject({ v: 1, applied: true, lane: 'devin', tier: null, requested: 2, errors: [] });
    expect(json().reports.map((r: ReassignReportV1) => r.moved[0].id)).toEqual(['RQ-PHX-FAKEONE01', 'RQ-PHX-EXTRA005']);
  });

  it('dry run leaves ready.tsv and the audit log untouched and still plans', async () => {
    const original = await readFile(readyPath, 'utf8');
    const { code } = await run(['--lane', 'devin', '--json', '--runs-dir', runsDir], stream('RQ-PHX-FAKEONE01\nRQ-PHX-FAKETWO02\n'));
    expect(code).toBe(0);
    expect(await readFile(readyPath, 'utf8')).toBe(original);
    await expect(readFile(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(json()).toMatchObject({ applied: false, requested: 2, errors: [] });
    expect(json().reports[1].moved).toEqual([{ id: 'RQ-PHX-FAKETWO02', fromLane: 'codex-personal', toLane: 'devin', fromTier: 'mid', toTier: 'mid' }]);
  });

  it('passes a tier through and never sets force', async () => {
    const { code, reassign } = await run(['--lane', 'devin', '--tier', 'fast', '--reason', 'lane held', '--runs-dir', runsDir], stream('RQ-PHX-FAKEONE01\n'));
    expect(code).toBe(0);
    expect(reassign).toHaveBeenCalledWith(
      { job: 'RQ-PHX-FAKEONE01', lane: 'devin', apply: false, tier: 'fast', reason: 'lane held' },
      { runsDir, changedBy: 'ashlr fleet reassign-stdin' });
  });

  it('executes a duplicated id once, in first-seen order', async () => {
    const { code, reassign } = await run(['--lane', 'devin', '--apply', '--runs-dir', runsDir, '--json'],
      stream('RQ-PHX-FAKETWO02\r\n  RQ-PHX-FAKEONE01  \n\nRQ-PHX-FAKETWO02\nRQ-PHX-FAKEONE01\n'));
    expect(code).toBe(0);
    expect(reassign.mock.calls.map(([input]) => input.job)).toEqual(['RQ-PHX-FAKETWO02', 'RQ-PHX-FAKEONE01']);
    expect(json().requested).toBe(2);
    expect(await logRows()).toHaveLength(2);
  });
});

describe('fleet reassign-stdin: per-id refusals and failures', () => {
  it('refuses a held target through the core and writes nothing', async () => {
    const original = await readFile(readyPath, 'utf8');
    const { code } = await run(['--lane', 'held-lane', '--apply', '--runs-dir', runsDir, '--json'], stream('RQ-PHX-FAKEONE01\n'));
    expect(code).toBe(0);
    expect(await readFile(readyPath, 'utf8')).toBe(original);
    expect(json()).toMatchObject({ reports: [], errors: [{ id: 'RQ-PHX-FAKEONE01', code: 'lane-held', message: 'Lane is held' }] });
  });

  it('keeps going past a launched job so a later id still moves', async () => {
    const { code } = await run(['--lane', 'devin', '--apply', '--runs-dir', runsDir, '--json'],
      stream('RQ-PHX-LAUNCHED9\nRQ-PHX-FAKEONE01\n'));
    expect(code).toBe(0);
    expect(json().errors).toEqual([{ id: 'RQ-PHX-LAUNCHED9', code: 'job-launched', message: 'Job already launched' }]);
    expect(json().reports.map((r: ReassignReportV1) => r.moved[0].id)).toEqual(['RQ-PHX-FAKEONE01']);
    const after = await ready();
    expect(after.find((line) => line.startsWith('RQ-PHX-FAKEONE01'))).toBe(row('RQ-PHX-FAKEONE01', 'devin'));
    expect(after.find((line) => line.startsWith('RQ-PHX-LAUNCHED9'))).toBe(row('RQ-PHX-LAUNCHED9', 'codex-personal'));
  });

  it('exits 1 and hides raw error text when the core throws an unexpected error', async () => {
    const boom = vi.fn(async (): Promise<ReassignReportV1> => { throw new Error('secret /home/leak/ready.tsv'); });
    const { code } = await run(['--lane', 'devin', '--apply', '--runs-dir', runsDir, '--json'],
      stream('RQ-PHX-FAKEONE01\nRQ-PHX-FAKETWO02\n'), { reassign: boom as unknown as typeof realCore });
    expect(code).toBe(1);
    expect(json().errors).toEqual([
      { id: 'RQ-PHX-FAKEONE01', code: 'unexpected', message: 'reassign failed' },
      { id: 'RQ-PHX-FAKETWO02', code: 'unexpected', message: 'reassign failed' },
    ]);
    expect(output.join('\n') + errors).not.toContain('secret');
  });

  it('exits 1 when an applied write is not verified', async () => {
    const unverified = async (input: ReassignInput): Promise<ReassignReportV1> => ({
      v: 1, generatedAt: NOW.toISOString(), applied: true, lane: input.lane, moved: [],
      skipped: [{ id: input.job!, reason: 'unverified' }], verified: false,
    });
    const { code } = await run(['--lane', 'devin', '--apply', '--runs-dir', runsDir, '--json'],
      stream('RQ-PHX-FAKEONE01\n'), { reassign: unverified });
    expect(code).toBe(1);
    expect(json().errors).toEqual([expect.objectContaining({ id: 'RQ-PHX-FAKEONE01', code: 'unverified' })]);
  });

  it('keeps the human report on stdout and labels refusals and failures', async () => {
    const { code } = await run(['--lane', 'held-lane', '--apply', '--runs-dir', runsDir], stream('RQ-PHX-FAKEONE01\n'));
    expect(code).toBe(0);
    expect(output.join('\n')).toBe('refused RQ-PHX-FAKEONE01  lane-held: Lane is held');
  });
});

describe('fleet reassign-stdin: input is validated before any mutation', () => {
  const expectNoMutation = async (reassign: ReturnType<typeof vi.fn>, original: string) => {
    expect(reassign).not.toHaveBeenCalled();
    expect(await readFile(readyPath, 'utf8')).toBe(original);
    await expect(readFile(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
  };

  it('refuses a malformed trailing line and invokes zero mutations', async () => {
    const original = await readFile(readyPath, 'utf8');
    const { code, reassign } = await run(['--lane', 'devin', '--apply', '--runs-dir', runsDir], stream('RQ-PHX-FAKEONE01\nnot-an-id\n'));
    expect(code).toBe(2);
    expect(errors).toContain('line 2 is not an RQ-PHX job id');
    expect(errors).not.toContain('not-an-id');
    await expectNoMutation(reassign, original);
  });

  it('refuses an empty input', async () => {
    const { code, reassign } = await run(['--lane', 'devin', '--apply', '--runs-dir', runsDir], stream('\n  \n'));
    expect(code).toBe(2);
    expect(errors).toContain('no job ids on stdin');
    expect(reassign).not.toHaveBeenCalled();
  });

  it('refuses oversize input before parsing it', async () => {
    const { code, reassign } = await run(['--lane', 'devin', '--apply', '--runs-dir', runsDir], stream('x'.repeat(32 * 1024 + 1)));
    expect(code).toBe(2);
    expect(errors).toContain('input exceeds 32768 bytes');
    expect(reassign).not.toHaveBeenCalled();
  });

  it('refuses more than 100 unique ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `RQ-PHX-BULK${String(i).padStart(4, '0')}`).join('\n');
    const { code, reassign } = await run(['--lane', 'devin', '--runs-dir', runsDir], stream(ids));
    expect(code).toBe(2);
    expect(errors).toContain('more than 100 unique job ids');
    expect(reassign).not.toHaveBeenCalled();
  });

  it('accepts exactly 100 unique ids (duplicates do not count)', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `RQ-PHX-BULK${String(i).padStart(4, '0')}`);
    const { code, reassign } = await run(['--lane', 'devin', '--runs-dir', runsDir, '--json'], stream([...ids, ...ids].join('\n')));
    expect(code).toBe(0);
    expect(reassign).toHaveBeenCalledTimes(100);
  });

  it('refuses a TTY before reading anything', async () => {
    const tty = Object.assign(new PassThrough(), { isTTY: true });
    const { code, reassign } = await run(['--lane', 'devin', '--runs-dir', runsDir], tty);
    expect(code).toBe(2);
    expect(errors).toContain('stdin must be piped');
    expect(reassign).not.toHaveBeenCalled();
  });

  it('expires a stalled, unterminated input and detaches every listener', async () => {
    const stalled = new PassThrough();
    stalled.write('RQ-PHX-FAKEONE01\n');
    const { code, reassign } = await run(['--lane', 'devin', '--apply', '--runs-dir', runsDir], stalled, { inputTimeoutMs: 20 });
    expect(code).toBe(2);
    expect(errors).toContain('did not reach end-of-input');
    expect(reassign).not.toHaveBeenCalled();
    expect(stalled.listenerCount('data')).toBe(0);
    expect(stalled.listenerCount('end')).toBe(0);
    expect(stalled.listenerCount('error')).toBe(0);
    expect(stalled.listenerCount('close')).toBe(0);
  });

  it.each([
    { args: ['--runs-dir', runsDir] },
    { args: ['--lane'] },
    { args: ['--lane', 'devin', '--lane', 'claude'] },
    { args: ['--lane', 'devin', '--apply', '--apply'] },
    { args: ['--lane', 'devin', '--bogus'] },
    { args: ['--lane', 'devin', 'RQ-PHX-FAKEONE01'] },
    { args: ['--lane', 'devin', '--runs-dir', 'relative/path'] },
  ])('rejects bad arguments before reading stdin: $args', async ({ args }) => {
    const stalled = new PassThrough();
    const { code, reassign } = await run(args, stalled, { inputTimeoutMs: 20 });
    expect(code).toBe(2);
    expect(errors).toContain('usage: ashlr fleet reassign-stdin');
    expect(errors).not.toContain('did not reach');
    expect(reassign).not.toHaveBeenCalled();
  });
});

describe('fleet reassign-stdin: help', () => {
  it('documents partial application and exits 0 without reading', async () => {
    const reassign = vi.fn(realCore);
    expect(await cmdFleetReassignStdin(['--help'], { input: stream(''), reassign })).toBe(0);
    expect(output[0]).toContain('PARTIAL APPLICATION: NOT atomic');
    expect(reassign).not.toHaveBeenCalled();
  });
});
