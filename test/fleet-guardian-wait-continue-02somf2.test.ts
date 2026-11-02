import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianWaitContinue } from '../src/cli/fleet-guardian-wait-continue.js';
import { cmdFleetGuardianRecord } from '../src/cli/fleet-guardian-record.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';
import type { GuardianDrainDeps } from '../src/core/fleet/guardian-retry-drain.js';

const dirs: string[] = [];
const tmp = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-wait-continue-'))); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const summary = { mode: 'apply', termination: 'drained', attempts: 1, verified: 1, refused: 0,
  attempted: [], planned: [], latestOutput: null, session: '/private/session' };
const quiet = (): void => { vi.spyOn(process.stderr, 'write').mockImplementation(() => true); };

async function recordReceipt(dir: string, file: string): Promise<void> {
  const ran = { state: 'ran', summary: { deadlineExceeded: false, cancelled: false } } as unknown as GuardianVerifyExclusiveResult;
  const drainDeps = {
    select: vi.fn(async () => ({ repo: join(dir, 'fake-repo'), sha: 'a'.repeat(40) })),
    prepare: vi.fn(async () => undefined) as unknown as NonNullable<GuardianDrainDeps['prepare']>,
    verify: vi.fn(async () => ran),
  };
  const args = ['--manifest', join(dir, 'manifest'), '--source-state', join(dir, 'source'), '--output-dir', dir,
    '--max-retries', '1', '--timeout-ms', '60000', '--new-session', '--apply', '--result-file', file];
  expect(await cmdFleetGuardianRecord(args, { drainDeps, output: () => {} })).toBe(0);
}

describe('fleet guardian-wait-continue', () => {
  it('waits for a real guardian-record receipt and continues the exact session once', async () => {
    const dir = tmp();
    const file = join(dir, 'receipt.json');
    const resume = vi.fn(async () => 0);
    const sleep = vi.fn(async () => { if (sleep.mock.calls.length === 2) await recordReceipt(dir, file); });
    const code = await cmdFleetGuardianWaitContinue(['--result-file', file, '--wait-ms', '5000', '--poll-ms', '10', '--timeout-ms', '1234'],
      { sleep, continueDeps: { resume } });
    expect(code).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledTimes(1);
    const session = (JSON.parse(readFileSync(file, 'utf8')) as { session: string }).session;
    expect(resume.mock.calls[0]![0]).toEqual(['--checkpoint-dir', session, '--timeout-ms', '1234']);
  });

  it('stays a preview without --apply and forwards explicit --apply exactly once', async () => {
    const dir = tmp();
    const file = join(dir, 'r.json');
    writeFileSync(file, JSON.stringify(summary));
    const resume = vi.fn(async () => 0);
    await cmdFleetGuardianWaitContinue(['--result-file', file, '--wait-ms', '50'], { continueDeps: { resume } });
    expect(resume.mock.calls[0]![0]).toEqual(['--checkpoint-dir', '/private/session']);
    await cmdFleetGuardianWaitContinue(['--wait-ms', '50', '--apply', '--result-file', file, '--json'], { continueDeps: { resume } });
    expect(resume.mock.calls[1]![0]).toEqual(['--checkpoint-dir', '/private/session', '--apply', '--json']);
  });

  it('preserves a nonzero delegate exit and calls it once, passing captured bytes', async () => {
    const reads = vi.fn(async () => ({ kind: 'text' as const, text: JSON.stringify(summary) }));
    const delegate = vi.fn(async () => 7);
    expect(await cmdFleetGuardianWaitContinue(['--result-file', '/a/b', '--wait-ms', '50', '--stream'], { read: reads, delegate })).toBe(7);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(delegate.mock.calls[0]![0]).toEqual(['--stdin', '--stream']);
    expect(Buffer.from(await delegate.mock.calls[0]![1]!.readInput!()).toString()).toBe(JSON.stringify(summary));
  });

  it('never reaches resume on refused, oversized or malformed input, and leaks nothing', async () => {
    quiet();
    const resume = vi.fn(async () => 0);
    const lines: string[] = [];
    const secret = 'sk-private-synthetic';
    const run = (read: () => Promise<unknown>) => cmdFleetGuardianWaitContinue(['--result-file', '/a/b', '--wait-ms', '500'],
      { read: read as never, continueDeps: { resume }, output: l => { lines.push(l); } });
    expect(await run(async () => ({ kind: 'refused', reason: secret }))).toBe(2);
    expect(await run(async () => { throw new Error(secret); })).toBe(2);
    expect(await run(async () => ({ kind: 'text', text: 'x'.repeat(32769) }))).toBe(2);
    for (const text of ['{', '{}', JSON.stringify({ ...summary, mode: 'preview' }), JSON.stringify({ ...summary, session: 'relative' })]) {
      expect(await run(async () => ({ kind: 'text', text }))).toBe(2);
    }
    expect(resume).not.toHaveBeenCalled();
    expect(lines.join('')).not.toContain(secret);
  });

  it('refuses a symlinked receipt without polling', async () => {
    quiet();
    const dir = tmp();
    const target = join(dir, 'real.json');
    writeFileSync(target, JSON.stringify(summary));
    const link = join(dir, 'link.json');
    symlinkSync(target, link);
    const resume = vi.fn(async () => 0);
    const sleep = vi.fn(async () => {});
    expect(await cmdFleetGuardianWaitContinue(['--result-file', link, '--wait-ms', '500'], { sleep, continueDeps: { resume } })).toBe(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('times out on a permanently missing receipt with sequential polls', async () => {
    quiet();
    let t = 0;
    const read = vi.fn(async () => ({ kind: 'missing' as const }));
    const sleep = vi.fn(async (ms: number) => { t += ms; });
    const delegate = vi.fn(async () => 0);
    const code = await cmdFleetGuardianWaitContinue(['--result-file', '/a/b', '--wait-ms', '95', '--poll-ms', '10'],
      { read, sleep, now: () => t, delegate });
    expect(code).toBe(1);
    expect(read).toHaveBeenCalledTimes(10);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('bounds a stalled read by the total deadline', async () => {
    quiet();
    const delegate = vi.fn(async () => 0);
    const started = performance.now();
    const code = await cmdFleetGuardianWaitContinue(['--result-file', '/a/b', '--wait-ms', '40'],
      { read: () => new Promise(() => {}), delegate });
    expect(code).toBe(1);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(delegate).not.toHaveBeenCalled();
  });

  it('rejects bad, duplicate and --stdin arguments before reading', async () => {
    quiet();
    const read = vi.fn(async () => ({ kind: 'missing' as const }));
    const delegate = vi.fn(async () => 0);
    const f = ['--result-file', '/a/b'];
    for (const args of [[], f, [...f, '--wait-ms'], [...f, '--wait-ms', '0'], [...f, '--wait-ms', '60001'], [...f, '--wait-ms', '1e3'],
      [...f, '--wait-ms', '5', '--wait-ms', '5'], [...f, '--wait-ms', '5', '--poll-ms', '9'], [...f, '--wait-ms', '5', '--poll-ms', '1001'],
      [...f, '--wait-ms', '5', '--poll-ms', '10', '--poll-ms', '10'], [...f, '--wait-ms', '5', '--stdin'],
      ['--wait-ms', '5', '--result-file', 'rel'], ['--wait-ms', '5', ...f, ...f], ['--wait-ms', '5', '--result-file', '/']]) {
      expect(await cmdFleetGuardianWaitContinue(args, { read, delegate })).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
    expect(delegate).not.toHaveBeenCalled();
  });
});
