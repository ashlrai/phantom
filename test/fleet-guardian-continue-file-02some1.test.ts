import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianContinueFile } from '../src/cli/fleet-guardian-continue-file.js';
import { cmdFleetGuardianRecord } from '../src/cli/fleet-guardian-record.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';
import type { GuardianDrainDeps } from '../src/core/fleet/guardian-retry-drain.js';

const dirs: string[] = [];
const tmp = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-continue-file-'))); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const summary = { mode: 'apply', termination: 'drained', attempts: 1, verified: 1, refused: 0,
  attempted: [], planned: [], latestOutput: null, session: '/private/session' };

async function recordReceipt(dir: string): Promise<string> {
  const file = join(dir, 'receipt.json');
  const ran = { state: 'ran', summary: { deadlineExceeded: false, cancelled: false } } as unknown as GuardianVerifyExclusiveResult;
  const drainDeps = {
    select: vi.fn(async () => ({ repo: join(dir, 'fake-repo'), sha: 'a'.repeat(40) })),
    prepare: vi.fn(async () => undefined) as unknown as NonNullable<GuardianDrainDeps['prepare']>,
    verify: vi.fn(async () => ran),
  };
  const args = ['--manifest', join(dir, 'manifest'), '--source-state', join(dir, 'source'), '--output-dir', dir,
    '--max-retries', '1', '--timeout-ms', '60000', '--new-session', '--apply', '--result-file', file];
  expect(await cmdFleetGuardianRecord(args, { drainDeps, output: () => {} })).toBe(0);
  return file;
}

describe('fleet guardian-continue-file', () => {
  it('resumes from a real guardian-record receipt, forwarding explicit --apply once', async () => {
    const dir = tmp();
    const file = await recordReceipt(dir);
    const before = readFileSync(file, 'utf8');
    const session = (JSON.parse(before) as { session: string }).session;
    const resume = vi.fn(async () => 0);
    expect(await cmdFleetGuardianContinueFile(['--result-file', file, '--apply', '--json'], { continueDeps: { resume } })).toBe(0);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]![0]).toEqual(['--checkpoint-dir', session, '--apply', '--json']);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('stays a preview without --apply', async () => {
    const dir = tmp();
    const file = await recordReceipt(dir);
    const resume = vi.fn(async () => 0);
    expect(await cmdFleetGuardianContinueFile(['--result-file', file], { continueDeps: { resume } })).toBe(0);
    expect(resume.mock.calls[0]![0]).not.toContain('--apply');
  });

  it('propagates a nonzero delegate exit code without retrying', async () => {
    const dir = tmp();
    const file = join(dir, 'r.json');
    writeFileSync(file, JSON.stringify(summary));
    const resume = vi.fn(async () => 5);
    expect(await cmdFleetGuardianContinueFile(['--result-file', file], { continueDeps: { resume } })).toBe(5);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('never resumes on missing, unsafe, oversized or malformed receipts, and leaks nothing', async () => {
    const dir = tmp();
    const resume = vi.fn(async () => 0);
    const lines: string[] = [];
    const output = (l: string): void => { lines.push(l); };
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const secret = 'sk-private-synthetic';
    const run = (read: () => Promise<never>) => cmdFleetGuardianContinueFile(['--result-file', join(dir, 'x')],
      { read: read as never, continueDeps: { resume }, output });
    expect(await run(async () => ({ kind: 'missing' }) as never)).toBe(2);
    expect(await run(async () => ({ kind: 'refused', reason: secret }) as never)).toBe(2);
    expect(await run(async () => { throw new Error(secret); })).toBe(2);
    expect(await run(async () => ({ kind: 'text', text: 'x'.repeat(32769) }) as never)).toBe(2);
    for (const text of ['{', '{}', JSON.stringify({ ...summary, mode: 'preview' }), JSON.stringify({ ...summary, session: 'relative' })]) {
      expect(await run(async () => ({ kind: 'text', text }) as never)).toBe(2);
    }
    expect(resume).not.toHaveBeenCalled();
    expect(lines.join('')).not.toContain(secret);
  });

  it('accepts a receipt of exactly 32KiB', async () => {
    const delegate = vi.fn(async () => 0);
    const text = 'x'.repeat(32 * 1024);
    expect(await cmdFleetGuardianContinueFile(['--result-file', '/a/b'], { read: async () => ({ kind: 'text', text }), delegate })).toBe(0);
    const input = await delegate.mock.calls[0]![1]!.readInput!();
    expect(Buffer.from(input).length).toBe(32 * 1024);
  });

  it('refuses a symlinked receipt on a real temp file without delegating', async () => {
    const dir = tmp();
    const target = join(dir, 'real.json');
    writeFileSync(target, JSON.stringify(summary));
    const link = join(dir, 'link.json');
    symlinkSync(target, link);
    const resume = vi.fn(async () => 0);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdFleetGuardianContinueFile(['--result-file', link], { continueDeps: { resume } })).toBe(2);
    expect(resume).not.toHaveBeenCalled();
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    expect(await cmdFleetGuardianContinueFile(['--result-file', join(sub, 'none.json')], { continueDeps: { resume } })).toBe(2);
  });

  it('rejects duplicate, missing, relative, root and --stdin arguments before reading', async () => {
    const read = vi.fn(async () => ({ kind: 'text' as const, text: '{}' }));
    const delegate = vi.fn(async () => 0);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const args of [[], ['--result-file'], ['--result-file', 'rel.json'], ['--result-file', '/'], ['--result-file', '/a/../b'],
      ['--result-file', '/a/b', '--result-file', '/a/b'], ['--result-file', '/a/b', '--result-file', '/a/c'], ['--result-file', '/a/b', '--stdin']]) {
      expect(await cmdFleetGuardianContinueFile(args, { read, delegate })).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
    expect(delegate).not.toHaveBeenCalled();
  });

  it('only reads the receipt: mode and content are unchanged', async () => {
    const dir = tmp();
    const file = join(dir, 'r.json');
    writeFileSync(file, JSON.stringify(summary), { mode: 0o600 });
    const mtime = statSync(file).mtimeMs;
    await cmdFleetGuardianContinueFile(['--result-file', file], { continueDeps: { resume: vi.fn(async () => 0) } });
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(summary));
    expect(statSync(file).mtimeMs).toBe(mtime);
  });
});
