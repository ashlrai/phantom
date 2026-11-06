/** Provider launch is mocked. These fixtures never execute Phantom or a reader. */
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usageReaderCommands, usageSignalReaders } from '../src/core/fabric/usage-signal-readers.js';
import { runUsageSignal } from '../src/cli/usage-signal.js';

const stubs = vi.hoisted(() => ({ execFile: vi.fn(), write: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFile: stubs.execFile,
}));
vi.mock('../src/core/fabric/usage-signal-writer.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fabric/usage-signal-writer.js')>(), writeUsageSignal: stubs.write,
}));
let root: string;
const reply = (stdout: string, error: Error | null = null) => {
  stubs.execFile.mockImplementation((_file: string, _args: string[], _options: unknown,
    callback: (failure: Error | null, output: string, stderr: string) => void) => {
    callback(error, stdout, ['TEST', 'DISCARDED', 'STDERR'].join('_'));
  });
};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-usage-adapters-')));
  chmodSync(root, 0o700);
  stubs.execFile.mockReset(); stubs.write.mockReset();
  stubs.write.mockResolvedValue({ written: ['terra'], debounced: [], signals: [] });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('usage reader execution envelope', () => {
  it('runs only configured readers through phantom exec with bounded scrubbed subprocess options', async () => {
    const privateValue = ['TEST', 'PROVIDER', 'KEY'].join('_');
    vi.stubEnv('XAI_API_KEY', privateValue);
    vi.stubEnv('ANTHROPIC_API_KEY', privateValue);
    vi.stubEnv('OPENAI_API_KEY', privateValue);
    vi.stubEnv('UNRELATED_PRIVATE_ENV', privateValue);
    const reading = { pool: 'terra', pctUsed: 10, resetAt: null, source: 'terra-reader', fetchedAt: '2026-10-26T12:00:00.000Z' };
    reply(JSON.stringify(reading));
    const commands = usageReaderCommands({ terra: join(root, 'read-terra') });
    const readers = usageSignalReaders(commands);
    expect(Object.keys(readers)).toEqual(['terra']);
    expect(await readers.terra!()).toEqual(reading);
    expect(stubs.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = stubs.execFile.mock.calls[0]!;
    expect(file).toBe('phantom');
    expect(args).toEqual(['exec', '--', join(root, 'read-terra')]);
    expect(options).toMatchObject({ shell: false, timeout: 15_000, maxBuffer: 8192, encoding: 'utf8' });
    expect(Object.keys(options.env).every(key => ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].includes(key))).toBe(true);
    expect(JSON.stringify(options.env)).not.toContain(privateValue);
  });

  it.each(['failure', 'malformed'] as const)('returns unknown for %s output without logging stderr or errors', async kind => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    reply(kind === 'malformed' ? '{broken' : '{}', kind === 'failure' ? new Error(['TEST', 'READER', 'FAILURE'].join('_')) : null);
    const reader = usageSignalReaders({ 'grok-ultra': join(root, 'read-grok') });
    expect(await reader['grok-ultra']!()).toBeNull();
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });

  it.each([
    null, [], { unknown: '/reader' }, { terra: 'relative-reader' }, { terra: ['/reader', '--credential'] },
    { terra: '/reader\nsecond-command' }, { terra: '/reader\0suffix' },
  ])('refuses invalid reader mappings (row %#)', value => {
    expect(() => usageReaderCommands(value)).toThrow('Invalid usage reader configuration');
    expect(stubs.execFile).not.toHaveBeenCalled();
  });
});

describe('bridge usage CLI', () => {
  it('passes the requested event and pools to a one-shot writer and prints only its result', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUsageSignal(['--directory', root, '--event', '429', '--pool', 'terra', '--pool', 'codex-cmp']);
    expect(stubs.write).toHaveBeenCalledWith({ directory: root, event: '429', pools: ['terra', 'codex-cmp'], readers: {} });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ written: ['terra'], debounced: [], signals: [] }));
    expect(stubs.execFile).not.toHaveBeenCalled();
  });

  it('loads a private adapter map without executing any provider during argument parsing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const config = join(root, 'readers.json');
    writeFileSync(config, JSON.stringify({ terra: join(root, 'read-terra') }), { mode: 0o600 });
    await runUsageSignal(['--directory', root, '--event', 'manual-reading', '--readers', config]);
    expect(stubs.write.mock.calls[0]?.[0]).toMatchObject({ directory: root, event: 'manual-reading' });
    expect(stubs.write.mock.calls[0]?.[0].readers.terra).toBeTypeOf('function');
    expect(stubs.execFile).not.toHaveBeenCalled();
    expect(readFileSync(config, 'utf8')).toBe(JSON.stringify({ terra: join(root, 'read-terra') }));
  });

  it.each([
    [], ['--directory'], ['--directory', 'relative', '--event', '429'],
    ['--event', 'timer'], ['--pool', 'unknown'], ['--unknown', 'value'],
  ])('rejects malformed CLI options before calling the writer (row %#)', async args => {
    await expect(runUsageSignal(args)).rejects.toThrow();
    expect(stubs.write).not.toHaveBeenCalled(); expect(stubs.execFile).not.toHaveBeenCalled();
  });

  it.each(['public-mode', 'symlink', 'malformed'] as const)('refuses a %s reader config before provider or writer invocation', async kind => {
    const target = join(root, 'target.json');
    writeFileSync(target, kind === 'malformed' ? '{broken' : '{}', { mode: 0o600 });
    const config = kind === 'symlink' ? join(root, 'readers.json') : target;
    if (kind === 'symlink') symlinkSync(target, config);
    if (kind === 'public-mode') chmodSync(config, 0o644);
    await expect(runUsageSignal(['--directory', root, '--event', 'manual-reading', '--readers', config])).rejects.toThrow();
    expect(stubs.write).not.toHaveBeenCalled(); expect(stubs.execFile).not.toHaveBeenCalled();
  });

  it.each(['.codex', '.codex-2'])('rejects a %s configuration path before attempting a file read', async name => {
    const neverCreated = join(root, name, 'FAKE-auth.json');
    await expect(runUsageSignal(['--directory', root, '--event', 'manual-reading', '--readers', neverCreated]))
      .rejects.toThrow('Reader configuration requires an operations path');
    expect(stubs.write).not.toHaveBeenCalled(); expect(stubs.execFile).not.toHaveBeenCalled();
  });
});
