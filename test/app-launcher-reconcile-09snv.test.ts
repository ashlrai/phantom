import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The default launcher binds node:child_process at import time; mock it so no test can start a real app.
const execMock = vi.hoisted(() => vi.fn((_f: string, _a: readonly string[], _o: unknown, cb: (e: Error | null) => void) => cb(null)));
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), execFile: execMock }));

import { cmdApps, type AppsFeedEntry } from '../src/cli/apps-control.js';
import { createMacOsAppLauncher, defaultHostAppLauncher } from '../src/core/verse/app-launcher.js';
import type { AppLauncher, ToolCall } from '../src/core/verse/desktop-adapters.js';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const LIST = ['1 running apps:', '- Notes (com.apple.Notes): up to full control [frontmost]'].join('\n');

let dir: string;
let feed: AppsFeedEntry[];
let lines: string[];
const realPlatform = process.platform;
const setPlatform = (p: string): void => { Object.defineProperty(process, 'platform', { value: p }); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apps-launch-'));
  feed = [];
  lines = [];
  execMock.mockClear();
});
afterEach(() => { setPlatform(realPlatform); rmSync(dir, { recursive: true, force: true }); });

function allow(apps: unknown[]): string {
  const file = join(dir, 'apps-allow.json');
  writeFileSync(file, JSON.stringify({ apps }));
  return file;
}
const baseDeps = (allowFile: string, extra: Record<string, unknown> = {}) => ({
  allowFile, out: (l: string) => { lines.push(l); }, feed: (e: AppsFeedEntry) => { feed.push(e); return true; }, ...extra,
});
const fakeLauncher = (result: { ok: true } | { ok: false; error: string } = { ok: true }) => {
  const l = { open: vi.fn(async () => result), activate: vi.fn(async () => result) };
  return l satisfies AppLauncher;
};
const report = () => JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
const OPEN_ARGV = [['/usr/bin/open', ['-b', 'com.example.Tool']]];

describe('macOS launcher', () => {
  it('runs fixed /usr/bin/open with argv and a timeout, never a shell', async () => {
    const exec = vi.fn((_f: string, _a: readonly string[], _o: { timeout: number }, cb: (e: Error | null) => void) => cb(null));
    expect(await createMacOsAppLauncher(exec).open('com.example.Tool')).toEqual({ ok: true });
    expect(exec.mock.calls.map((c) => [c[0], c[1]])).toEqual(OPEN_ARGV);
    expect(exec.mock.calls[0]![2]).toEqual({ timeout: 15_000 });
  });

  it('validates bundle ids before spawning and surfaces exec errors', async () => {
    const exec = vi.fn((_f: string, _a: readonly string[], _o: { timeout: number }, cb: (e: Error | null) => void) => cb(new Error('boom')));
    const launcher = createMacOsAppLauncher(exec);
    for (const bad of ['Notes', '-a.b', 'a.b; rm -rf /', 'a b.c', '']) {
      expect(await launcher.open(bad)).toMatchObject({ ok: false });
    }
    expect(exec).not.toHaveBeenCalled();
    expect(await launcher.open('com.example.Tool')).toEqual({ ok: false, error: 'boom' });
  });

  it('is only the default on darwin', () => {
    expect(defaultHostAppLauncher('linux')).toBeUndefined();
    expect(defaultHostAppLauncher('win32')).toBeUndefined();
    expect(defaultHostAppLauncher('darwin')).toBeDefined();
  });
});

describe('phm apps open through cmdApps', () => {
  const file = () => allow([{ name: 'Tool', bundleId: 'com.example.Tool' }, 'Plain', { name: 'com.example.NameOnly' }, 'ai.ashlr.desktop', 'com.apple.keychainaccess']);

  it('opens an allowlisted bundle with no desktop connection via the injected launcher', async () => {
    const launcher = fakeLauncher();
    expect(await cmdApps(['open', 'Tool', '--json'], baseDeps(file(), { launcher }))).toBe(0);
    expect(launcher.open).toHaveBeenCalledWith('com.example.Tool');
    expect(feed.map((e) => e.phase)).toEqual(['start', 'result']);
    expect(report()).toMatchObject({ ok: true, outcome: 'done' });
  });

  it('uses the default launcher only on darwin', async () => {
    setPlatform('darwin');
    expect(await cmdApps(['open', 'Tool'], baseDeps(file()))).toBe(0);
    expect(execMock.mock.calls.map((c) => [c[0], c[1]])).toEqual(OPEN_ARGV);
    execMock.mockClear();
    setPlatform('linux');
    expect(await cmdApps(['open', 'Tool', '--json'], baseDeps(file()))).toBe(1);
    expect(execMock).not.toHaveBeenCalled();
    expect(report()).toMatchObject({ ok: false, code: 'failed' });
  });

  it('does not default a launcher when a desktop connection is supplied', async () => {
    setPlatform('darwin');
    const call: ToolCall = async () => ok('0 running apps:');
    expect(await cmdApps(['open', 'Tool', '--json'], baseDeps(file(), { call }))).toBe(1);
    expect(report()).toMatchObject({ code: 'unsupported' });
    expect(execMock).not.toHaveBeenCalled();
  });

  it('launcher null disables the default even on darwin', async () => {
    setPlatform('darwin');
    expect(await cmdApps(['open', 'Tool'], baseDeps(file(), { launcher: null }))).toBe(1);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('reports a launcher failure cleanly', async () => {
    const launcher = fakeLauncher({ ok: false, error: 'spawn failed' });
    expect(await cmdApps(['open', 'Tool', '--json'], baseDeps(file(), { launcher }))).toBe(1);
    expect(report()).toMatchObject({ ok: false, outcome: 'failed', detail: 'spawn failed' });
  });

  it('launches nothing for a denylisted target, a missing allowlist entry, a name-only entry or a failed feed', async () => {
    const launcher = fakeLauncher();
    const f = file();
    expect(await cmdApps(['open', 'com.apple.keychainaccess', '--json'], baseDeps(f, { launcher }))).toBe(1);
    expect(report()).toMatchObject({ outcome: 'refused', code: 'denied' });
    expect(await cmdApps(['open', 'com.example.Other', '--json'], baseDeps(f, { launcher }))).toBe(1);
    expect(report()).toMatchObject({ code: 'not-allowlisted' });
    expect(await cmdApps(['open', 'Plain', '--json'], baseDeps(f, { launcher }))).toBe(1);
    expect(await cmdApps(['open', 'com.example.NameOnly', '--json'], baseDeps(f, { launcher }))).toBe(1);
    expect(await cmdApps(['open', 'Tool', '--json'], baseDeps(f, { launcher, feed: () => false }))).toBe(1);
    expect(report()).toMatchObject({ code: 'feed-unavailable' });
    expect(launcher.open).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('does not skip a connected desktop whose app list errors (kill, pause, no grant)', async () => {
    const launcher = fakeLauncher();
    const call: ToolCall = async () => ({ content: [{ type: 'text', text: 'KILL is engaged' }], isError: true });
    expect(await cmdApps(['open', 'Tool', '--json'], baseDeps(file(), { launcher, call }))).toBe(1);
    expect(launcher.open).not.toHaveBeenCalled();
  });

  it('does not launch an app the connected desktop already lists as running', async () => {
    const launcher = fakeLauncher();
    const call: ToolCall = async () => ok(LIST);
    expect(await cmdApps(['open', 'com.apple.Notes', '--json'], baseDeps(allow(['com.apple.Notes']), { launcher, call }))).toBe(0);
    expect(report()).toMatchObject({ ok: true, running: true });
    expect(launcher.open).not.toHaveBeenCalled();
  });

  it('keeps focus and quit tied to the desktop connection', async () => {
    const launcher = fakeLauncher();
    const f = allow([{ name: 'Tool', bundleId: 'com.example.Tool' }]);
    expect(await cmdApps(['focus', 'Tool'], baseDeps(f, { launcher }))).toBe(1);
    expect(await cmdApps(['quit', 'Tool'], baseDeps(f, { launcher }))).toBe(1);
    expect(launcher.open).not.toHaveBeenCalled();
    expect(launcher.activate).not.toHaveBeenCalled();
  });
});
