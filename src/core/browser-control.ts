/**
 * Safari, Phantom's own agent browser: `phm browser`, the Browser card and
 * GET/POST /api/verse/apps/browser all run through runBrowser. It extends the
 * Apps surface (apps-known.ts names Safari); it is not a second browser layer.
 *
 * Everything goes through one injectable runner. Tabs, open, close and the
 * window id use AppleScript; the screenshot uses screencapture; doctor reads
 * safaridriver and the "Allow remote automation" setting and never changes it.
 * Chrome, its profiles and any non-web address are refused before the runner.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ashlrHome } from './cloud/store.js';
import { isPaused } from './comms/pause.js';
import { appendBusInbox } from './fleet/bus-inbox.js';
import { killSwitchOn } from './sandbox/policy.js';
import { scrubSecrets } from './util/scrub.js';

export const BROWSER_ACTIONS = ['doctor', 'open', 'tabs', 'shot', 'close'] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];
export type BrowserOutcome = 'done' | 'refused' | 'failed' | 'needs_permission';

/** `code` is the exit code, or null when the program is not on this Mac. */
export interface BrowserRunResult { code: number | null; stdout: string; stderr: string }
export type BrowserRunner = (file: string, args: readonly string[]) => Promise<BrowserRunResult>;

export interface BrowserTab { id: string; window: number; index: number; url: string; title: string }
export interface BrowserDoctor {
  safaridriver: 'found' | 'missing' | 'unknown';
  safaridriverVersion: string | null;
  remoteAutomation: 'enabled' | 'disabled' | 'unknown';
  /** The one step for the owner, or null when nothing is needed. */
  fix: string | null;
}
export interface BrowserShot { path: string; at: string; bytes: number }
export interface BrowserReport {
  schema: 'phm.browser/1';
  /** Bumps only on a breaking change; new fields are additive. */
  version: 1;
  browser: 'safari';
  action: BrowserAction;
  ok: boolean;
  outcome: BrowserOutcome;
  code?: string;
  detail: string;
  doctor?: BrowserDoctor;
  /** tabs: whether Safari is running; null when it could not be read. */
  running?: boolean | null;
  tabs?: BrowserTab[];
  url?: string;
  /** shot: the file just written. tabs: the latest screenshot, or null when there is none. */
  shot?: BrowserShot | null;
  closed?: number;
  /** open, shot and close are recorded on the feed. */
  logged?: boolean;
}
export interface BrowserRequest { action: BrowserAction; url?: string; path?: string; browser?: string }
export interface BrowserDeps {
  /** `undefined` uses the macOS runner; `null` means this host cannot drive Safari. */
  runner?: BrowserRunner | null;
  /** Where the latest screenshot is kept for the card. */
  shotFile?: string;
  feed?: (entry: { action: BrowserAction; outcome: BrowserOutcome; detail: string }) => boolean;
  writesBlocked?: () => boolean;
  out?: (line: string) => void;
}

export const REMOTE_AUTOMATION_FIX = 'In Safari, open Settings > Developer and turn on "Allow remote automation".';
export const AUTOMATION_PANE = 'System Settings > Privacy & Security > Automation';
export const SCREEN_RECORDING_PANE = 'System Settings > Privacy & Security > Screen & System Audio Recording';
const CHROME_REASON = 'Chrome is your own browser, and Phantom never touches it. Phantom drives only Safari.';
const SAFARI = 'application id "com.apple.Safari"';
const SCRIPTS = {
  open: `on run argv\ntell ${SAFARI}\nif (count of windows) is 0 then\nmake new document with properties {URL:item 1 of argv}\nelse\ntell window 1 to set current tab to (make new tab with properties {URL:item 1 of argv})\nend if\nend tell\nend run`,
  tabs: `if ${SAFARI} is not running then return "not-running"\nset out to "running"\ntell ${SAFARI}\nrepeat with w in windows\nset wid to id of w\nrepeat with t in tabs of w\nset u to URL of t\nif u is missing value then set u to ""\nset out to out & linefeed & wid & tab & (index of t) & tab & u & tab & (name of t)\nend repeat\nend repeat\nend tell\nreturn out`,
  window: `if ${SAFARI} is not running then return "not-running"\ntell ${SAFARI}\nif (count of windows) is 0 then return "no-window"\nreturn id of window 1\nend tell`,
  close: `if ${SAFARI} is not running then return "not-running"\ntell ${SAFARI}\nset n to count of windows\nclose every window\nreturn n\nend tell`,
} as const;

export const defaultShotFile = (): string => join(ashlrHome(), 'browser', 'latest.png');

export function defaultBrowserRunner(platform = process.platform): BrowserRunner | null {
  if (platform !== 'darwin') return null;
  return (file, args) => new Promise((done) => {
    try {
      execFile(file, [...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        done({ code: !error ? 0 : error.code === 'ENOENT' ? null : typeof error.code === 'number' ? error.code : 1, stdout, stderr });
      });
    } catch { done({ code: 1, stdout: '', stderr: 'the program could not be started' }); }
  });
}

/** Page text and addresses are untrusted: one line, scrubbed, bounded. */
const oneLine = (text: string, max = 300): string => scrubSecrets(text.replace(/\p{Cc}/gu, ' ')).trim().slice(0, max);

/** The plain reason when a browser name, address or file path points at Chrome; null otherwise. */
export function chromeRefusal(...targets: Array<string | undefined>): string | null {
  return targets.some(t => /^(google ?)?chrom(e|ium)|^com\.google\.chrome|[\\/](Google[\\/]Chrome|Chromium)([\\/]|$)/i.test(t?.trim() ?? '')) ? CHROME_REASON : null;
}

function defaultFeed(entry: { action: BrowserAction; outcome: BrowserOutcome; detail: string }): boolean {
  try {
    return appendBusInbox({
      id: `browser-${randomUUID()}`, from: 'browser', to: 'mason', priority: 'P3', ttl: 7 * 24 * 60 * 60 * 1000,
      body: { kind: 'browser', browser: 'safari', ...entry },
    }).status === 'posted';
  } catch { return false; }
}

export function parseTabs(text: string): BrowserTab[] {
  return text.split('\n').slice(1).flatMap((line) => {
    const [window, index, url, ...title] = line.split('\t');
    return /^\d+$/.test(window ?? '') && /^\d+$/.test(index ?? '')
      ? [{ id: `${window}:${index}`, window: Number(window), index: Number(index), url: oneLine(url ?? '', 2048), title: oneLine(title.join(' ')) }] : [];
  });
}

async function latestShot(file: string): Promise<BrowserShot | null> {
  try { const s = await stat(file); return s.isFile() && s.size > 0 ? { path: file, at: s.mtime.toISOString(), bytes: s.size } : null; }
  catch { return null; }
}

type Body = Omit<BrowserReport, 'schema' | 'version' | 'browser' | 'action' | 'ok'>;
const fail = (outcome: BrowserOutcome, code: string, detail: string, extra: Partial<Body> = {}): Body => ({ outcome, code, detail, ...extra });

/** Why an AppleScript call did not work, in plain words. */
function scriptFailure(r: BrowserRunResult): Body {
  if (r.code === null) return fail('failed', 'unsupported', 'osascript is not on this host; Safari can only be driven on macOS.');
  if (/-1743|not authori[sz]ed/i.test(r.stderr)) {
    return fail('needs_permission', 'needs-permission', `Phantom needs permission to control Safari. Turn Safari on for Phantom (or your terminal app) in ${AUTOMATION_PANE}, then try again.`);
  }
  return fail('failed', 'failed', `Safari did not answer: ${oneLine(r.stderr.split('\n').find(l => l.trim()) ?? 'no reason given', 160)}`);
}

async function act(input: BrowserRequest, run: BrowserRunner, deps: BrowserDeps): Promise<Body> {
  const script = (name: keyof typeof SCRIPTS, ...args: string[]) => run('/usr/bin/osascript', ['-e', SCRIPTS[name], ...args]);
  const shotFile = deps.shotFile ?? defaultShotFile();
  if (input.action === 'doctor') {
    const driver = await run('/usr/bin/safaridriver', ['--version']);
    const setting = await run('/usr/bin/defaults', ['read', 'com.apple.Safari', 'AllowRemoteAutomation']);
    const value = setting.stdout.trim();
    const safaridriver = driver.code === null ? 'missing' : driver.code === 0 ? 'found' : 'unknown';
    // A key that was never written means the switch has never been turned on.
    const remoteAutomation = setting.code === 0 && (value === '1' || value === '0') ? (value === '1' ? 'enabled' : 'disabled')
      : setting.code !== null && setting.code !== 0 && /does not exist/i.test(setting.stderr) ? 'disabled' : 'unknown';
    const fix = safaridriver === 'missing' ? 'safaridriver ships with Safari: update macOS or Safari, then run phm browser doctor again.'
      : remoteAutomation === 'enabled' ? null : REMOTE_AUTOMATION_FIX;
    const doctor: BrowserDoctor = { safaridriver, safaridriverVersion: safaridriver === 'found' ? oneLine(driver.stdout, 120) || null : null, remoteAutomation, fix };
    if (safaridriver === 'missing') return fail('failed', 'safaridriver-missing', `safaridriver is not on this Mac. ${fix}`, { doctor });
    if (remoteAutomation === 'enabled' && safaridriver === 'found') return { outcome: 'done', detail: 'Safari remote automation is on. Nothing to do.', doctor };
    if (remoteAutomation === 'disabled') return fail('failed', 'remote-automation-off', `Safari remote automation is off. ${fix} Phantom never changes this setting for you.`, { doctor });
    return fail('failed', 'unknown', `Phantom could not read ${safaridriver === 'unknown' ? 'safaridriver' : 'whether Safari remote automation is on'}, so its state is unknown.${fix ? ` If remote automation is off: ${fix}` : ''}`, { doctor });
  }
  if (input.action === 'tabs') {
    const r = await script('tabs');
    if (r.code !== 0) return { ...scriptFailure(r), running: null, tabs: [], shot: await latestShot(shotFile) };
    const running = r.stdout.trimStart().startsWith('running');
    const tabs = running ? parseTabs(r.stdout.trim()) : [];
    return { outcome: 'done', running, tabs, shot: await latestShot(shotFile),
      detail: !running ? 'Safari is not running. No agent tabs.' : tabs.length === 0 ? 'Safari is running with no tabs.' : `${tabs.length} agent tab${tabs.length === 1 ? '' : 's'} open in Safari.` };
  }
  if (input.action === 'open') {
    const r = await script('open', input.url!);
    return r.code === 0 ? { outcome: 'done', detail: `opened ${oneLine(input.url!, 200)} in Safari.`, url: oneLine(input.url!, 2048) } : scriptFailure(r);
  }
  if (input.action === 'close') {
    const r = await script('close');
    if (r.code !== 0) return scriptFailure(r);
    const closed = /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : 0;
    return { outcome: 'done', closed, detail: r.stdout.trim() === 'not-running' ? 'Safari is not running; nothing to close.' : `closed ${closed} Safari window${closed === 1 ? '' : 's'}.` };
  }
  const path = resolve(input.path ?? shotFile);
  const win = await script('window');
  if (win.code !== 0) return scriptFailure(win);
  const id = win.stdout.trim();
  if (!/^\d+$/.test(id)) return fail('failed', id === 'not-running' ? 'not-running' : 'no-window', `Safari ${id === 'not-running' ? 'is not running' : 'has no window'}. Open a page first: phm browser open <url>`);
  const started = Date.now();
  try { await mkdir(dirname(path), { recursive: true }); await mkdir(dirname(shotFile), { recursive: true, mode: 0o700 }); } catch { /* the capture reports it */ }
  const cap = await run('/usr/sbin/screencapture', ['-x', '-o', '-l', id, path]);
  const shot = await latestShot(path);
  // screencapture can exit 0 without writing; an older file at the path is not this screenshot.
  if (cap.code !== 0 || !shot || Date.parse(shot.at) < started - 2_000) {
    return fail('failed', 'no-screenshot', `macOS did not save a screenshot; the cause is unknown. The usual one is Screen Recording being off for Phantom or your terminal app: ${SCREEN_RECORDING_PANE}.`);
  }
  if (path !== shotFile) { try { await copyFile(path, shotFile); } catch { /* the card keeps its last screenshot */ } }
  return { outcome: 'done', detail: `saved a screenshot of Safari to ${path}.`, shot };
}

/** Refusals that never reach the runner: bad shape, Chrome, non-web addresses, KILL and pause. */
function refusal(input: BrowserRequest, deps: BrowserDeps): Body | null {
  if (input.browser !== undefined && !/^(safari|com\.apple\.safari)$/i.test(input.browser.trim())) {
    return chromeRefusal(input.browser) ? fail('refused', 'protected', CHROME_REASON) : fail('refused', 'unsupported', 'Phantom drives only Safari.');
  }
  const chrome = chromeRefusal(input.url?.split(/[/?#]/)[0], input.path === undefined ? undefined : resolve(input.path));
  if (chrome) return fail('refused', 'protected', chrome);
  if (input.action === 'open') {
    let url: URL | null = null;
    try { url = new URL(input.url ?? ''); } catch { url = null; }
    if (!url || !['http:', 'https:'].includes(url.protocol) || /\p{Cc}/u.test(input.url!) || input.url!.length > 2048) return fail('refused', 'bad-url', 'only http and https addresses can be opened.');
    if (url.username || url.password) return fail('refused', 'bad-url', 'addresses with a sign-in inside them are not opened.');
  }
  if (input.action === 'shot' && input.path !== undefined && (!/\.png$/i.test(input.path) || /\p{Cc}/u.test(input.path))) return fail('refused', 'bad-path', 'the screenshot path must end in .png.');
  if (['open', 'close'].includes(input.action) && (deps.writesBlocked ?? (() => killSwitchOn() || isPaused()))()) return fail('refused', 'writes-blocked', 'browser actions are stopped by KILL or comms pause.');
  return null;
}

function humanText(report: BrowserReport): string {
  const lines = [report.detail];
  if (report.doctor) lines.push(`safaridriver: ${report.doctor.safaridriver}${report.doctor.safaridriverVersion ? ` (${report.doctor.safaridriverVersion})` : ''}`, `remote automation: ${report.doctor.remoteAutomation}`);
  for (const tab of report.tabs ?? []) lines.push(`${tab.id}  ${tab.title || 'Untitled'}  ${tab.url || 'no address'}`);
  if (report.action === 'tabs') lines.push(report.shot ? `Latest screenshot: ${report.shot.path} (${report.shot.at})` : 'No screenshot yet. Take one with: phm browser shot <path>');
  return lines.join('\n');
}

/** Shared typed browser surface for the CLI, the API and the card. Exit: 0 done, 1 refused or failed, 2 invalid. */
export async function runBrowser(input: BrowserRequest, deps: BrowserDeps = {}): Promise<{ exit: number; report: BrowserReport; text: string }> {
  const base = { schema: 'phm.browser/1', version: 1, browser: 'safari', action: input.action } as const;
  const done = (body: Body, exit = body.outcome === 'done' ? 0 : 1) => {
    const report: BrowserReport = { ...base, ok: body.outcome === 'done', ...body };
    return { exit, report, text: humanText(report) };
  };
  if (!BROWSER_ACTIONS.includes(input.action) || (input.action === 'open') !== (input.url !== undefined) || (input.path !== undefined && input.action !== 'shot')) {
    return done(fail('refused', 'invalid-request', 'invalid browser request.'), 2);
  }
  const refused = refusal(input, deps);
  if (refused) return done(refused);
  const run = deps.runner === undefined ? defaultBrowserRunner() : deps.runner;
  if (!run) return done(fail('failed', 'unsupported', 'Safari can only be driven on macOS; this host has no runner.', input.action === 'tabs' ? { running: null, tabs: [], shot: null } : {}));
  const body = await act(input, run, deps);
  if (['open', 'shot', 'close'].includes(input.action)) body.logged = (deps.feed ?? defaultFeed)({ action: input.action, outcome: body.outcome, detail: body.detail });
  return done(body);
}
