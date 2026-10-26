import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAbsolute, win32 } from 'node:path';

const harness = vi.hoisted(() => ({
  replies: new Map<string, { stdout: string; stderr?: string; error?: Error }>(),
  pending: [] as Array<() => void>,
  calls: [] as Array<{ command: string; args: string[]; options: Record<string, unknown>; end: ReturnType<typeof vi.fn> }>,
  deferred: false,
  nativeLookup: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: (command: string, args: string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const end = vi.fn();
    harness.calls.push({ command, args, options, end });
    const finish = () => {
      const reply = harness.replies.get(`${command} ${args.join(' ')}`);
      callback(reply?.error ?? (reply ? null : Object.assign(new Error('missing'), { code: 'ENOENT' })), reply?.stdout ?? '', reply?.stderr ?? '');
    };
    if (harness.deferred) harness.pending.push(finish);
    else queueMicrotask(finish);
    return { stdin: { end } };
  },
  execFileSync: (command: string, args: string[]) => {
    const reply = harness.replies.get(`${command} ${args.join(' ')}`);
    if (!reply || reply.error) throw reply?.error ?? Object.assign(new Error('missing'), { code: 'ENOENT' });
    return reply.stdout;
  },
}));

vi.mock('../src/doctor/executable.js', () => ({ findDoctorExecutable: harness.nativeLookup }));

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: () => false,
}));

import { getToolsRegistry } from '../src/core/tools-registry.js';

function locator(binary: string): string {
  return process.platform === 'win32'
    ? `${win32.join(process.env.SystemRoot!, 'System32', 'where.exe')} $PATH:${binary}`
    : `which ${binary}`;
}

function located(binary: string, version: string, error?: Error): string {
  const path = process.platform === 'win32' ? `C:\\phantom-fixture-does-not-exist\\${binary}.exe` : `/phantom-fixture-does-not-exist/${binary}`;
  harness.replies.set(locator(binary), { stdout: `${path}\n` });
  harness.replies.set(`${path} --version`, { stdout: version, ...(error ? { error } : {}) });
  return path;
}

beforeEach(() => {
  harness.replies.clear();
  harness.pending = [];
  harness.calls = [];
  harness.deferred = false;
  harness.nativeLookup.mockImplementation((binary: string) => harness.replies.get(locator(binary))?.stdout.trim() || null);
  if (process.platform === 'win32') vi.stubEnv('SystemRoot', 'C:\\Windows');
});
afterEach(() => vi.unstubAllEnvs());

describe('parallel doctor tool inventory', () => {
  it('starts independent probes before waiting, then preserves canonical inventory order and parsing', async () => {
    located('phantom', 'phantom 0.6.2');
    located('locus', 'locus 1.3.0');
    located('stack', 'usage: system stack');
    harness.deferred = true;
    const pendingRegistry = getToolsRegistry({ parallel: true });
    expect(harness.calls.length).toBeGreaterThan(5);
    expect(harness.calls.every(call => call.args[0] !== '--version')).toBe(true);
    for (let round = 0; round < 10 && harness.pending.length; round++) {
      const batch = harness.pending.splice(0);
      batch.forEach(finish => finish());
      await Promise.resolve();
    }
    const registry = await pendingRegistry;
    harness.deferred = false;
    expect(registry).toEqual(getToolsRegistry());
    expect(registry.tools.find(tool => tool.id === 'phantom')).toMatchObject({ installed: true, version: '0.6.2' });
    expect(registry.tools.find(tool => tool.id === 'locus')).toMatchObject({ installed: true, version: '1.3.0' });
    expect(registry.tools.find(tool => tool.id === 'stack')).toMatchObject({ installed: false, version: null, path: null });
  });

  it('executes absolute located paths without a shell, kills timed-out children, caps output and closes stdin', async () => {
    const phantom = located('phantom', 'phantom 0.6.2');
    await getToolsRegistry({ parallel: true });
    const versionCalls = harness.calls.filter(call => call.args[0] === '--version');
    expect(versionCalls).toHaveLength(1);
    expect(versionCalls[0]!.command).toBe(phantom);
    expect(process.platform === 'win32' ? win32.isAbsolute(phantom) : isAbsolute(phantom)).toBe(true);
    for (const call of harness.calls) {
      expect(call.options.shell).toBeUndefined();
      expect(call.options.killSignal).toBe('SIGKILL');
      expect(call.options.timeout).toBe(3_000);
      expect(call.options.maxBuffer).toBe(1024 * 1024);
      expect(call.end).toHaveBeenCalledOnce();
    }
  });

  it('uses fresh native PATH lookup without locator subprocesses on POSIX and retains Windows locator behavior', async () => {
    located('phantom', 'phantom 0.6.2');
    located('locus', 'locus 1.3.0');
    located('stack', 'stack 2.0.0');
    const registry = await getToolsRegistry({ parallel: true, nativePath: true });
    expect(registry).toEqual(getToolsRegistry());
    if (process.platform === 'win32') {
      expect(harness.nativeLookup).not.toHaveBeenCalled();
      expect(harness.calls.some(call => call.args[0] !== '--version')).toBe(true);
    } else {
      expect(harness.nativeLookup).toHaveBeenCalledWith('phantom');
      expect(harness.nativeLookup).toHaveBeenCalledWith('locus');
      expect(harness.calls).toHaveLength(3);
      expect(harness.calls.every(call => call.args[0] === '--version')).toBe(true);
    }
  });

  it('uses fallback candidates only after earlier aliases miss', async () => {
    const fallback = located('ashlr-mcp', 'ashlr-mcp 2.7.0');
    const registry = await getToolsRegistry({ parallel: true });
    expect(registry.tools.find(tool => tool.id === 'ashlr-plugin')).toMatchObject({ installed: true, version: '2.7.0', path: fallback });
    const lookupOrder = harness.calls.map(call => `${call.command} ${call.args.join(' ')}`);
    expect(lookupOrder.indexOf(locator('ashlr-plugin'))).toBeLessThan(lookupOrder.indexOf(locator('ashlr-mcp')));
  });

  it('does not trust partial version output from killed or oversized probes', async () => {
    located('phantom', 'phantom 0.6.2', Object.assign(new Error('timeout'), { killed: true, signal: 'SIGKILL' }));
    located('stack', 'stack 9.9.9', Object.assign(new Error('output too large'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
    const registry = await getToolsRegistry({ parallel: true });
    expect(registry.tools.find(tool => tool.id === 'phantom')).toMatchObject({ installed: true, version: null });
    expect(registry.tools.find(tool => tool.id === 'stack')).toMatchObject({ installed: false, version: null });
  });

  it('degrades missing or timed-out tools and retains version output on ordinary nonzero exits', async () => {
    located('phantom', 'phantom 0.6.2', Object.assign(new Error('exit 1'), { code: 1 }));
    located('stack', '', Object.assign(new Error('timeout'), { killed: true, signal: 'SIGKILL' }));
    const registry = await getToolsRegistry({ parallel: true });
    expect(registry.tools.find(tool => tool.id === 'phantom')).toMatchObject({ installed: true, version: '0.6.2' });
    expect(registry.tools.find(tool => tool.id === 'stack')).toMatchObject({ installed: false, version: null });
    expect(registry.tools.find(tool => tool.id === 'locus')).toMatchObject({ installed: false, version: null });
    expect(registry.installedCount).toBe(registry.tools.filter(tool => tool.installed).length);
  });
});
