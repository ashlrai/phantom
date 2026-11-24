import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdBrowser } from '../src/cli/browser.js';
import { REMOTE_AUTOMATION_FIX, runBrowser, type BrowserDeps, type BrowserRunResult, type BrowserRunner } from '../src/core/browser-control.js';
import { APPS_BROWSER_DOCTOR_PATH, APPS_BROWSER_PATH, APPS_BROWSER_SHOT_PATH, createAppsBrowserApi } from '../src/core/verse/apps-browser-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

type Step = 'driver' | 'setting' | 'tabs' | 'window' | 'open' | 'close' | 'capture';
const done = (stdout = ''): BrowserRunResult => ({ code: 0, stdout, stderr: '' });
const TABS = 'running\n41\t1\thttps://example.com/\tExample Domain\n41\t2\thttps://example.org/docs\tDocs\n';

/** A Safari that never runs anything: canned answers per step, and a record of every call. */
function fake(over: Partial<Record<Step, BrowserRunResult>> = {}) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const runner: BrowserRunner = async (file, args) => {
    calls.push({ file, args });
    if (file.endsWith('safaridriver')) return over.driver ?? done('Included with Safari 27.2\n');
    if (file.endsWith('defaults')) return over.setting ?? done('1\n');
    if (file.endsWith('screencapture')) { if (!over.capture) writeFileSync(args.at(-1)!, 'png-bytes'); return over.capture ?? done(); }
    const script = args[1]!;
    if (script.startsWith('on run argv')) return over.open ?? done();
    if (script.includes('close every window')) return over.close ?? done('2\n');
    if (script.includes('return id of window 1')) return over.window ?? done('41\n');
    return over.tabs ?? done(TABS);
  };
  return { runner, calls };
}

let root: string;
let shotFile: string;
const deps = (runner: BrowserRunner | null, extra: BrowserDeps = {}): BrowserDeps => ({ runner, shotFile, feed: () => true, writesBlocked: () => false, ...extra });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'browser-')); shotFile = join(root, 'home', 'latest.png'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('phm browser doctor', () => {
  it('says remote automation is on, with a stable versioned schema', async () => {
    const { runner, calls } = fake();
    const { exit, report } = await runBrowser({ action: 'doctor' }, deps(runner));
    expect(exit).toBe(0);
    expect(report).toEqual({ schema: 'phm.browser/1', version: 1, browser: 'safari', action: 'doctor', ok: true, outcome: 'done',
      detail: 'Safari remote automation is on. Nothing to do.',
      doctor: { safaridriver: 'found', safaridriverVersion: 'Included with Safari 27.2', remoteAutomation: 'enabled', fix: null } });
    // Doctor only reads: it never enables automation or writes a setting.
    expect(calls.map(c => [c.file, ...c.args].join(' '))).toEqual(['/usr/bin/safaridriver --version', '/usr/bin/defaults read com.apple.Safari AllowRemoteAutomation']);
  });

  it.each([
    ['switched off', done('0\n')],
    ['never switched on', { code: 1, stdout: '', stderr: 'The domain/default pair of (com.apple.Safari, AllowRemoteAutomation) does not exist' }],
  ])('names the one step when remote automation is %s', async (_name, setting) => {
    const { exit, report, text } = await runBrowser({ action: 'doctor' }, deps(fake({ setting }).runner));
    expect(exit).toBe(1);
    expect(report).toMatchObject({ ok: false, outcome: 'failed', code: 'remote-automation-off', doctor: { safaridriver: 'found', remoteAutomation: 'disabled', fix: REMOTE_AUTOMATION_FIX } });
    expect(text).toContain(`Safari remote automation is off. ${REMOTE_AUTOMATION_FIX} Phantom never changes this setting for you.`);
  });

  it('reports a missing safaridriver, and unknown stays unknown', async () => {
    const missing = await runBrowser({ action: 'doctor' }, deps(fake({ driver: { code: null, stdout: '', stderr: '' } }).runner));
    expect(missing.report).toMatchObject({ ok: false, code: 'safaridriver-missing', doctor: { safaridriver: 'missing', safaridriverVersion: null } });
    expect(missing.report.detail).toMatch(/^safaridriver is not on this Mac\./);
    const unknown = await runBrowser({ action: 'doctor' }, deps(fake({ setting: { code: 1, stdout: '', stderr: 'could not read the setting' } }).runner));
    expect(unknown.report).toMatchObject({ ok: false, code: 'unknown', doctor: { remoteAutomation: 'unknown', fix: REMOTE_AUTOMATION_FIX } });
    expect(unknown.report.detail).toContain('its state is unknown');
    const noHost = await runBrowser({ action: 'tabs' }, deps(null));
    expect(noHost.report).toMatchObject({ ok: false, code: 'unsupported', running: null, tabs: [], shot: null });
  });
});

describe('phm browser open, tabs, shot and close', () => {
  it('opens a web address in Safari, passing it as an argument and logging to the feed', async () => {
    const { runner, calls } = fake();
    const feed: unknown[] = [];
    const { exit, report } = await runBrowser({ action: 'open', url: 'https://example.com/' }, deps(runner, { feed: (e) => { feed.push(e); return true; } }));
    expect(exit).toBe(0);
    expect(report).toMatchObject({ schema: 'phm.browser/1', version: 1, ok: true, action: 'open', url: 'https://example.com/', detail: 'opened https://example.com/ in Safari.', logged: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('/usr/bin/osascript');
    expect(calls[0]!.args[1]).toContain('application id "com.apple.Safari"');
    expect(calls[0]!.args[2]).toBe('https://example.com/');
    expect(feed).toEqual([{ action: 'open', outcome: 'done', detail: 'opened https://example.com/ in Safari.' }]);
  });

  it('refuses addresses that are not plain web pages, and stops for KILL or pause', async () => {
    const { runner, calls } = fake();
    const signedIn = new URL('https://example.com/'); signedIn.username = 'someone';
    for (const url of ['file:///etc/hosts', 'javascript:alert(1)', 'not a url', signedIn.href]) {
      expect((await runBrowser({ action: 'open', url }, deps(runner))).report).toMatchObject({ ok: false, outcome: 'refused', code: 'bad-url' });
    }
    expect((await runBrowser({ action: 'open', url: 'https://example.com/' }, deps(runner, { writesBlocked: () => true }))).report).toMatchObject({ outcome: 'refused', code: 'writes-blocked' });
    expect((await runBrowser({ action: 'close' }, deps(runner, { writesBlocked: () => true }))).report.code).toBe('writes-blocked');
    expect((await runBrowser({ action: 'open' }, deps(runner))).exit).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('lists agent tabs, and says so when Safari is not running or not permitted', async () => {
    const open = await runBrowser({ action: 'tabs' }, deps(fake().runner));
    expect(open.report).toMatchObject({ ok: true, running: true, shot: null, detail: '2 agent tabs open in Safari.', tabs: [
      { id: '41:1', window: 41, index: 1, url: 'https://example.com/', title: 'Example Domain' },
      { id: '41:2', window: 41, index: 2, url: 'https://example.org/docs', title: 'Docs' }] });
    expect(open.text).toContain('41:2  Docs  https://example.org/docs');
    const idle = await runBrowser({ action: 'tabs' }, deps(fake({ tabs: done('not-running\n') }).runner));
    expect(idle.report).toMatchObject({ ok: true, running: false, tabs: [], detail: 'Safari is not running. No agent tabs.' });
    const denied = await runBrowser({ action: 'tabs' }, deps(fake({ tabs: { code: 1, stdout: '', stderr: 'execution error: Not authorized to send Apple events to Safari. (-1743)' } }).runner));
    expect(denied.report).toMatchObject({ ok: false, outcome: 'needs_permission', code: 'needs-permission', running: null, tabs: [] });
    expect(denied.report.detail).toContain('System Settings > Privacy & Security > Automation');
  });

  it('saves a screenshot of the Safari window and keeps the latest for the card', async () => {
    const { runner, calls } = fake();
    const path = join(root, 'out', 'page.png');
    const { exit, report } = await runBrowser({ action: 'shot', path }, deps(runner));
    expect(exit).toBe(0);
    expect(report).toMatchObject({ ok: true, action: 'shot', logged: true, shot: { path, bytes: 9 } });
    expect(calls.at(-1)).toEqual({ file: '/usr/sbin/screencapture', args: ['-x', '-o', '-l', '41', path] });
    expect(readFileSync(shotFile, 'utf8')).toBe('png-bytes');
    expect((await runBrowser({ action: 'tabs' }, deps(runner))).report.shot).toMatchObject({ path: shotFile, bytes: 9 });
  });

  it('does not claim a screenshot it could not take', async () => {
    const silent = await runBrowser({ action: 'shot', path: join(root, 'none.png') }, deps(fake({ capture: done() }).runner));
    expect(silent.report).toMatchObject({ ok: false, outcome: 'failed', code: 'no-screenshot' });
    expect(silent.report.detail).toContain('the cause is unknown');
    expect(existsSync(shotFile)).toBe(false);
    const idle = fake({ window: done('not-running\n') });
    expect((await runBrowser({ action: 'shot' }, deps(idle.runner))).report).toMatchObject({ ok: false, code: 'not-running' });
    expect(idle.calls.some(c => c.file.endsWith('screencapture'))).toBe(false);
    expect((await runBrowser({ action: 'shot', path: join(root, 'page.txt') }, deps(idle.runner))).report.code).toBe('bad-path');
  });

  it('closes Safari windows without quitting Safari', async () => {
    const { runner, calls } = fake();
    expect((await runBrowser({ action: 'close' }, deps(runner))).report).toMatchObject({ ok: true, closed: 2, detail: 'closed 2 Safari windows.', logged: true });
    expect(calls[0]!.args[1]).not.toMatch(/\bquit\b/);
    expect((await runBrowser({ action: 'close' }, deps(fake({ close: done('not-running\n') }).runner))).report.detail).toBe('Safari is not running; nothing to close.');
  });
});

describe('Chrome is never touched', () => {
  it.each([
    [{ action: 'tabs', browser: 'chrome' }], [{ action: 'tabs', browser: 'Google Chrome' }], [{ action: 'close', browser: 'com.google.Chrome' }],
    [{ action: 'doctor', browser: 'Chromium' }], [{ action: 'open', url: 'https://example.com/', browser: 'Google Chrome Canary' }],
    [{ action: 'open', url: 'chrome://settings' }], [{ action: 'open', url: 'googlechrome://example.com/' }], [{ action: 'open', url: 'chrome-extension://tab-a/page.html' }],
    [{ action: 'shot', path: '/Users/someone/Library/Application Support/Google/Chrome/Default/page.png' }],
  ] as const)('refuses %o before anything runs', async (input) => {
    const { runner, calls } = fake();
    const { exit, report } = await runBrowser(input, deps(runner));
    expect(exit).toBe(1);
    expect(report).toMatchObject({ ok: false, outcome: 'refused', code: 'protected', browser: 'safari', detail: 'Chrome is your own browser, and Phantom never touches it. Phantom drives only Safari.' });
    expect(calls).toHaveLength(0);
  });

  it('refuses other browsers too, and still opens web pages about Chrome in Safari', async () => {
    const { runner, calls } = fake();
    expect((await runBrowser({ action: 'tabs', browser: 'firefox' }, deps(runner))).report).toMatchObject({ outcome: 'refused', code: 'unsupported' });
    expect(calls).toHaveLength(0);
    expect((await runBrowser({ action: 'open', url: 'https://example.com/chrome', browser: 'Safari' }, deps(runner))).report.ok).toBe(true);
  });
});

describe('phm browser CLI', () => {
  const cli = async (args: string[], runner = fake().runner) => {
    const lines: string[] = [];
    const exit = await cmdBrowser(args, deps(runner, { out: (line) => lines.push(line) }));
    return { exit, out: lines.join('\n') };
  };
  it('lists tabs by default and prints the typed report with --json', async () => {
    const tabs = await cli(['--json']);
    expect(tabs.exit).toBe(0);
    expect(JSON.parse(tabs.out)).toMatchObject({ schema: 'phm.browser/1', version: 1, action: 'tabs', tabs: [{ id: '41:1' }, { id: '41:2' }] });
    expect((await cli(['open', 'https://example.com/'])).out).toBe('opened https://example.com/ in Safari.');
    expect(JSON.parse((await cli(['doctor', '--json'])).out).doctor.remoteAutomation).toBe('enabled');
    expect((await cli(['--help'])).out).toContain('phm browser doctor');
  });
  it('refuses Chrome and rejects bad usage', async () => {
    const chrome = await cli(['open', 'https://example.com/', '--browser', 'chrome', '--json']);
    expect(chrome.exit).toBe(1);
    expect(JSON.parse(chrome.out).code).toBe('protected');
    for (const bad of [['open'], ['dance'], ['tabs', 'extra'], ['close', '--force'], ['tabs', '--browser']]) expect((await cli(bad)).exit).toBe(2);
  });
});

describe('/api/verse/apps/browser', () => {
  async function request(path: string, body?: unknown, options: { address?: string; allowDispatch?: boolean; runner?: BrowserRunner } = {}) {
    const req = Object.assign(new PassThrough(), { headers: { 'content-type': 'application/json', 'x-ashlr-token': 'fixture' }, socket: { remoteAddress: options.address ?? '127.0.0.1' } }) as unknown as IncomingMessage;
    let status = 0, response = '';
    const res = { writeHead(code: number) { status = code; return this; }, end(text: string) { response = text; } } as unknown as ServerResponse;
    const pending = createAppsBrowserApi(deps(options.runner ?? fake().runner))({ token: 'fixture', allowDispatch: options.allowDispatch ?? true } as VerseApiContext, req, res, path, body === undefined ? 'GET' : 'POST');
    (req as unknown as PassThrough).end(body === undefined ? '' : JSON.stringify(body));
    expect(await pending).toBe(true);
    return { status, body: JSON.parse(response) };
  }

  it('serves the same reports as the CLI', async () => {
    expect(await request(APPS_BROWSER_PATH)).toMatchObject({ status: 200, body: { schema: 'phm.browser/1', version: 1, action: 'tabs', tabs: [{ id: '41:1' }, { id: '41:2' }], shot: null } });
    expect(await request(APPS_BROWSER_DOCTOR_PATH)).toMatchObject({ status: 200, body: { action: 'doctor', doctor: { remoteAutomation: 'enabled' } } });
    expect((await request(APPS_BROWSER_SHOT_PATH)).status).toBe(404);
    expect(await request(APPS_BROWSER_PATH, { action: 'shot' })).toMatchObject({ status: 200, body: { ok: true, shot: { path: shotFile } } });
    expect((await request(APPS_BROWSER_SHOT_PATH)).body).toEqual({ version: 1, dataUrl: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}` });
    expect(await request(APPS_BROWSER_PATH, { action: 'open', url: 'https://example.com/' })).toMatchObject({ status: 200, body: { ok: true, action: 'open' } });
    // A read that cannot reach Safari still answers 200, with the reason in the report.
    expect(await request(APPS_BROWSER_PATH, undefined, { runner: fake({ tabs: { code: 1, stdout: '', stderr: 'no answer' } }).runner })).toMatchObject({ status: 200, body: { ok: false, running: null } });
  });

  it('refuses Chrome, file paths, remote callers and read-only servers', async () => {
    expect(await request(APPS_BROWSER_PATH, { action: 'open', url: 'https://example.com/', browser: 'chrome' })).toMatchObject({ status: 422, body: { code: 'protected' } });
    expect((await request(APPS_BROWSER_PATH, { action: 'shot', path: join(root, 'page.png') })).status).toBe(400);
    expect((await request(APPS_BROWSER_PATH, { action: 'doctor' })).status).toBe(400);
    expect((await request(APPS_BROWSER_DOCTOR_PATH, { action: 'close' })).status).toBe(405);
    expect((await request(APPS_BROWSER_PATH, undefined, { address: '10.0.0.5' })).status).toBe(403);
    expect((await request(APPS_BROWSER_PATH, { action: 'close' }, { allowDispatch: false })).status).toBe(404);
  });
});
