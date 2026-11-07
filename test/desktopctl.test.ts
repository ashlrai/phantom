import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdDesktopctl, type DesktopctlFeedEntry } from '../src/cli/desktopctl.js';
import {
  createBrowserDesktopAdapter,
  parseRunningApps,
  runningBrowserApp,
  type ToolCall,
} from '../src/core/verse/desktop-adapters.js';
import {
  createDesktopctlAdapters,
  parseDesktopctlFlag,
  parseDesktopPermissionsText,
  probeDesktopCapabilities,
  readDesktopctlFlag,
  DESKTOPCTL_FLAG_OFF,
} from '../src/core/verse/desktopctl.js';
import { formatComputerPermissionReport, parseComputerPermissions, formatAxNode } from '../src/core/verse/verse-mcp-computer.js';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const treeText = (nodes: Array<Record<string, unknown>>): string =>
  ['Accessibility tree of X', '<untrusted id="a" source="s">', ...nodes.map((n) => formatAxNode(n)), '</untrusted id="a">'].join('\n');

const PERMS_ALL = 'desktop-permissions: supported=true macos=15.1 screen=granted accessibility=granted postEvents=granted';

const APPS = [
  '4 running apps:',
  '<untrusted id="a" source="s">',
  '- Claude (com.anthropic.claudefordesktop): up to full control; this chat holds full control [frontmost]',
  '- Codex (com.openai.codex): up to full control; this chat holds read only',
  '- Safari (com.apple.Safari): up to read only; this chat holds read only',
  '- Notes (com.apple.Notes): up to full control',
  '</untrusted id="a">',
].join('\n');

const IDLE = [
  { ref: 'e1', role: 'AXTextArea', title: 'Write your message', value: '', depth: 1, focused: true },
  { ref: 'e2', role: 'AXButton', title: 'Send', depth: 1 },
  { ref: 'e3', role: 'AXStaticText', value: 'here is the answer', depth: 2 },
];
const WORKING = [{ ref: 'e1', role: 'AXButton', title: 'Stop response' }];

interface FakeOpts {
  apps?: string | 'error';
  perms?: string | 'error' | 'unknown-tool';
  tree?: Array<Record<string, unknown>> | 'error';
}

/** A desktop connection standing in for the chat's computer_* transport. */
function fakeDesktop(opts: FakeOpts = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const call: ToolCall = async (name, args) => {
    calls.push({ name, args });
    if (name === 'computer_permissions') {
      if (opts.perms === 'error') return err('window-not-open');
      if (opts.perms === 'unknown-tool') return err('unknown tool: computer_permissions');
      return ok(opts.perms ?? PERMS_ALL);
    }
    if (name === 'computer_list_apps') return opts.apps === 'error' ? err('window-not-open') : ok(opts.apps ?? APPS);
    if (name === 'computer_request_access') return ok('requested');
    if (name === 'computer_ax_tree') return opts.tree === 'error' ? err('not granted') : ok(treeText(opts.tree ?? IDLE));
    if (name === 'computer_ax_press' || name === 'computer_type' || name === 'computer_key') return ok('done');
    return err(`unexpected tool ${name}`);
  };
  return { call, calls, names: () => calls.map((c) => c.name) };
}

describe('parseRunningApps held tier', () => {
  it('reads the held grant from "this chat holds X"', () => {
    expect(parseRunningApps(APPS).map((a) => [a.name, a.heldTier])).toEqual([
      ['Claude', 'full'], ['Codex', 'read'], ['Safari', 'read'], ['Notes', null],
    ]);
    expect(parseRunningApps(APPS)[0]!.frontmost).toBe(true);
  });
});

describe('desktopctl flag', () => {
  it('is off by default and on only for "enabled": true', () => {
    expect(parseDesktopctlFlag('{"enabled":true}')).toEqual({ ok: true, flag: { enabled: true, bundleIds: {} } });
    expect(parseDesktopctlFlag('{"enabled":false}')).toMatchObject({ ok: true, flag: { enabled: false } });
    expect(parseDesktopctlFlag('{}').ok).toBe(false);
    expect(parseDesktopctlFlag('{"enabled":"yes"}').ok).toBe(false);
    expect(parseDesktopctlFlag('{"enabled":true,"extra":1}').ok).toBe(false);
    expect(parseDesktopctlFlag('nope').ok).toBe(false);
  });
  it('accepts beta bundle overrides for task resources only', () => {
    const good = parseDesktopctlFlag('{"enabled":true,"bundleIds":{"claude":"com.anthropic.claude.beta","codex":"com.openai.codex.beta"}}');
    expect(good).toMatchObject({ ok: true, flag: { enabled: true, bundleIds: { claude: 'com.anthropic.claude.beta', codex: 'com.openai.codex.beta' } } });
    for (const bad of ['{"enabled":true,"bundleIds":{"browser":"com.x.y"}}', '{"enabled":true,"bundleIds":{"claude":"not a bundle"}}', '{"enabled":true,"bundleIds":"x"}']) {
      expect(parseDesktopctlFlag(bad).ok).toBe(false);
    }
  });
  it('reads a missing file as off and a bad file as an error, both closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desktopctl-flag-'));
    try {
      const missing = readDesktopctlFlag(join(dir, 'desktopctl.json'));
      expect(missing).toMatchObject({ ok: true, flag: { enabled: false } });
      writeFileSync(join(dir, 'desktopctl.json'), '{');
      const bad = readDesktopctlFlag(join(dir, 'desktopctl.json'));
      expect(bad.ok).toBe(false);
      expect(bad.flag.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('desktop permissions text', () => {
  it('parses the machine line and degrades on absent or malformed values', () => {
    expect(parseDesktopPermissionsText(`header\n${PERMS_ALL}\nfooter`)).toEqual({
      supported: true, macos: '15.1', screen: 'granted', accessibility: 'granted', postEvents: 'granted',
    });
    expect(parseDesktopPermissionsText('no line here')).toBeNull();
    expect(parseDesktopPermissionsText('desktop-permissions: supported=nope screen=yes accessibility=no postEvents=?')).toEqual({
      supported: null, macos: null, screen: 'unknown', accessibility: 'unknown', postEvents: 'unknown',
    });
  });
  it('round-trips parseComputerPermissions → formatComputerPermissionReport', () => {
    const report = parseComputerPermissions({ supported: true, macos: '15.1', screen: true, accessibility: false, postEvents: true });
    expect(report).toMatchObject({ supported: true, accessibility: 'missing', postEvents: 'granted' });
    const parsed = parseDesktopPermissionsText(formatComputerPermissionReport(report).join('\n'));
    expect(parsed).toMatchObject({ screen: 'granted', accessibility: 'missing', postEvents: 'granted' });
  });
});

describe('probeDesktopCapabilities', () => {
  const ON = { flag: { enabled: true, bundleIds: {} } };

  it('reports every resource not-connected without a desktop connection', async () => {
    const d = fakeDesktop({ apps: 'error' });
    const caps = await probeDesktopCapabilities(d.call, ON);
    expect(caps.connected).toBe(false);
    for (const r of caps.resources) {
      expect(r.running).toBeNull();
      expect(r.can).toEqual({ status: false, read: false, run: false });
      expect(r.reasons).toEqual(['not-connected']);
    }
  });

  it('blocks everything with flag-off, before asking what is running', async () => {
    const d = fakeDesktop();
    const caps = await probeDesktopCapabilities(d.call, { flag: DESKTOPCTL_FLAG_OFF });
    expect(caps.flagEnabled).toBe(false);
    for (const r of caps.resources) expect(r.reasons).toEqual(['flag-off']);
  });

  it('maps the happy path: task apps can run, a read-tier app can read only', async () => {
    const d = fakeDesktop();
    const caps = await probeDesktopCapabilities(d.call, ON);
    const byId = Object.fromEntries(caps.resources.map((r) => [r.id, r]));
    expect(byId['claude']).toMatchObject({ running: true, bundleId: 'com.anthropic.claudefordesktop', heldTier: 'full', can: { status: true, read: true, run: true } });
    // A held read-tier grant still reads, but cannot drive: that needs full.
    expect(byId['codex']).toMatchObject({ running: true, heldTier: 'read', can: { status: true, read: true, run: false }, reasons: ['tier:insufficient'] });
    expect(byId['devin']).toMatchObject({ running: false, can: { status: false, read: false, run: false }, reasons: ['not-running'] });
    expect(byId['browser']).toMatchObject({ kind: 'read', running: true, bundleId: 'com.apple.Safari', can: { status: true, read: true, run: false }, reasons: ['read-only-resource'] });
  });

  it('degrades per missing TCC grant: no accessibility blocks all; no post-events blocks acting only', async () => {
    const noAx = fakeDesktop({ perms: 'desktop-permissions: supported=true macos=15.1 screen=granted accessibility=missing postEvents=missing' });
    const caps = await probeDesktopCapabilities(noAx.call, ON);
    for (const r of caps.resources) {
      expect(r.can).toEqual({ status: false, read: false, run: false });
      expect(r.reasons).toContain(r.id === 'devin' ? 'not-running' : 'permission:accessibility');
    }
    const noEvents = fakeDesktop({ perms: 'desktop-permissions: supported=true macos=15.1 screen=granted accessibility=granted postEvents=missing' });
    const caps2 = await probeDesktopCapabilities(noEvents.call, ON);
    const claude = caps2.resources.find((r) => r.id === 'claude')!;
    expect(claude.can).toEqual({ status: true, read: true, run: false });
    expect(claude.reasons).toEqual(['permission:post-events']);
  });

  it('lets run ask for a grant but keeps status and read blocked until one is held', async () => {
    const apps = '- Devin (ai.cognition.devin): up to full control';
    const caps = await probeDesktopCapabilities(fakeDesktop({ apps }).call, ON);
    const devin = caps.resources.find((r) => r.id === 'devin')!;
    expect(devin).toMatchObject({ running: true, heldTier: null, can: { status: false, read: false, run: true }, reasons: ['not-granted'] });
  });

  it('reports an unavailable permission check as unknown, never granted', async () => {
    const caps = await probeDesktopCapabilities(fakeDesktop({ perms: 'unknown-tool' }).call, ON);
    expect(caps.permissions.checked).toBe(false);
    expect(caps.permissions.accessibility).toBe('unknown');
    // Unknown grants do not block: the calls themselves will say no-permission.
    expect(caps.resources.find((r) => r.id === 'claude')!.can).toEqual({ status: true, read: true, run: true });
  });

  it('resolves a bundle override from the flag file', async () => {
    const apps = '- Claude Beta (com.anthropic.claude.beta): up to full control; this chat holds full control';
    const caps = await probeDesktopCapabilities(fakeDesktop({ apps }).call, { flag: { enabled: true, bundleIds: { claude: 'com.anthropic.claude.beta' } } });
    expect(caps.resources.find((r) => r.id === 'claude')).toMatchObject({ running: true, bundleId: 'com.anthropic.claude.beta' });
  });
});

describe('browser resource adapter', () => {
  it('is in the interchangeable set and refuses to be tasked', async () => {
    const d = fakeDesktop();
    const adapters = createDesktopctlAdapters(d.call, { enabled: true, bundleIds: {} });
    expect(Object.keys(adapters)).toEqual(['claude', 'codex', 'devin', 'browser']);
    const res = await adapters.browser.start('go to example.com');
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('Browser pane') });
    expect(d.names()).toEqual([]);
  });

  it('reads the running browser through the accessibility tree only', async () => {
    const d = fakeDesktop({ tree: [{ ref: 'e1', role: 'AXStaticText', value: 'page content' }] });
    const adapters = createDesktopctlAdapters(d.call);
    expect((await adapters.browser.status('com.apple.Safari')).state).toBe('idle');
    const got = await adapters.browser.collect('com.apple.Safari');
    expect(got).toMatchObject({ ok: true, text: 'page content', untrusted: true });
    expect(new Set(d.names())).toEqual(new Set(['computer_ax_tree']));
  });

  it('finds a running browser by bundle id', () => {
    const apps = parseRunningApps(APPS);
    expect(runningBrowserApp(apps)?.bundleId).toBe('com.apple.Safari');
    expect(runningBrowserApp(parseRunningApps('- Notes (com.apple.Notes): up to full control'))).toBeNull();
    expect(createBrowserDesktopAdapter(async () => err('x')).id).toBe('browser');
  });
});

describe('phm desktopctl', () => {
  let dir: string;
  let flagFile: string;
  let lines: string[];
  let feed: DesktopctlFeedEntry[];
  const base = () => ({
    flagFile,
    out: (l: string) => lines.push(l),
    feed: (e: DesktopctlFeedEntry) => { feed.push(e); return true; },
    sleep: async () => {},
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desktopctl-'));
    flagFile = join(dir, 'desktopctl.json');
    lines = [];
    feed = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const enable = () => writeFileSync(flagFile, '{"enabled":true}');

  it('prints usage for --help anywhere and exits 0', async () => {
    expect(await cmdDesktopctl(['run', '--help'], base())).toBe(0);
    expect(lines[0]).toContain('phm desktopctl capabilities');
  });

  it('rejects unknown verbs, resources and task text with exit 2', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const args of [
      [], ['dance'], ['status'], ['status', 'safari'], ['status', 'claude', 'x'],
      ['run', 'claude'], ['run', 'mail', '--task', 'x'], ['run', 'claude', '--task'],
      ['run', 'claude', '--task', 'x', '--timeout', '2'], ['run', 'claude', '--task', 'x', '--bogus', 'y'],
    ]) expect(await cmdDesktopctl(args, base())).toBe(2);
    stderr.mockRestore();
  });

  it('capabilities always runs and reports the flag off without touching grants', async () => {
    const d = fakeDesktop();
    expect(await cmdDesktopctl(['capabilities', '--json'], { ...base(), call: d.call })).toBe(0);
    const out = JSON.parse(lines[0]!);
    expect(out).toMatchObject({ ok: true, action: 'capabilities', flagEnabled: false, connected: true });
    expect(out.resources).toHaveLength(4);
    expect(out.resources.every((r: { reasons: string[] }) => r.reasons[0] === 'flag-off')).toBe(true);
    // The doctor may observe (list apps, check permissions) but never acts.
    expect(new Set(d.names())).toEqual(new Set(['computer_list_apps', 'computer_permissions']));
  });

  it('status and run refuse flag-off without a single desktop call', async () => {
    const d = fakeDesktop();
    expect(await cmdDesktopctl(['status', 'claude', '--json'], { ...base(), call: d.call })).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, outcome: 'refused', code: 'flag-off' });
    lines = [];
    expect(await cmdDesktopctl(['run', 'claude', '--task', 'x', '--json'], { ...base(), call: d.call })).toBe(1);
    expect(d.names()).toEqual([]);
    expect(feed.map((e) => e.outcome).filter(Boolean)).toEqual(['refused', 'refused']);
  });

  it('reports capability state through status when the resource is usable', async () => {
    enable();
    const d = fakeDesktop({ tree: WORKING });
    expect(await cmdDesktopctl(['status', 'claude', '--json'], { ...base(), call: d.call })).toBe(0);
    const out = JSON.parse(lines[0]!);
    expect(out).toMatchObject({ ok: true, outcome: 'done', state: 'working', signals: ['stop-control'] });
    expect(d.calls.find((c) => c.name === 'computer_ax_tree')?.args['app']).toBe('com.anthropic.claudefordesktop');
  });

  it('status fails closed (refused, not-granted) when no grant is held', async () => {
    enable();
    const d = fakeDesktop({ apps: '- Devin (ai.cognition.devin): up to full control' });
    expect(await cmdDesktopctl(['status', 'devin', '--json'], { ...base(), call: d.call })).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, outcome: 'refused', code: 'not-granted' });
  });

  it('status reports not-connected as a failure', async () => {
    enable();
    const d = fakeDesktop({ apps: 'error' });
    expect(await cmdDesktopctl(['status', 'claude', '--json'], { ...base(), call: d.call })).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, outcome: 'failed', code: 'not-connected' });
  });

  it('run drives a task to a collected answer and logs start and result', async () => {
    enable();
    const d = fakeDesktop();
    expect(await cmdDesktopctl(['run', 'claude', '--task', 'fix the bug', '--json'], { ...base(), call: d.call })).toBe(0);
    const out = JSON.parse(lines[0]!);
    expect(out).toMatchObject({ ok: true, outcome: 'done', resource: 'claude', polls: 2, untrusted: true });
    expect(out.text).toContain('here is the answer');
    expect(d.names()).toContain('computer_ax_press');
    expect(d.names()).toContain('computer_type');
    expect(feed.map((e) => [e.phase, e.action, e.outcome])).toEqual([['start', 'run', undefined], ['result', 'run', 'done']]);
  });

  it('run refuses the read-only browser resource before acting', async () => {
    enable();
    const d = fakeDesktop();
    expect(await cmdDesktopctl(['run', 'browser', '--task', 'open example.com', '--json'], { ...base(), call: d.call })).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, outcome: 'refused', code: 'read-only-resource' });
    expect(d.names().filter((n) => n === 'computer_ax_press' || n === 'computer_type')).toEqual([]);
  });

  it('run fails fast on a resource that is not running', async () => {
    enable();
    const d = fakeDesktop({ apps: '- Safari (com.apple.Safari): up to read only; this chat holds read only' });
    expect(await cmdDesktopctl(['run', 'devin', '--task', 'x', '--json'], { ...base(), call: d.call })).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, outcome: 'failed', code: 'not-running' });
    expect(d.names()).not.toContain('computer_ax_tree');
  });

  it('run fails when the resource is waiting for an approval only the operator can give', async () => {
    enable();
    const workingThenApproval = [
      { ref: 'e1', role: 'AXButton', title: 'Stop response' },
      { ref: 'e2', role: 'AXButton', title: 'Allow once' },
    ];
    const d = fakeDesktop({ tree: [...IDLE, ...workingThenApproval] });
    expect(await cmdDesktopctl(['run', 'claude', '--task', 'x', '--json'], { ...base(), call: d.call })).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, outcome: 'failed', code: 'smoke-status' });
  });

  it('does not run an action whose feed entry cannot be written', async () => {
    enable();
    const d = fakeDesktop();
    expect(await cmdDesktopctl(['status', 'claude', '--json'], { ...base(), call: d.call, feed: () => false })).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'refused', code: 'feed-unavailable', logged: false });
    expect(d.names()).toEqual([]);
  });

  it('fails closed when no desktop connection is supplied', async () => {
    enable();
    expect(await cmdDesktopctl(['status', 'claude', '--json'], base())).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, outcome: 'failed', code: 'not-connected' });
  });

  it('reports a malformed flag file in capabilities and still refuses acting verbs', async () => {
    writeFileSync(flagFile, '{');
    const d = fakeDesktop();
    expect(await cmdDesktopctl(['capabilities', '--json'], { ...base(), call: d.call })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, flagEnabled: false, flagError: expect.stringContaining('JSON') });
    lines = [];
    expect(await cmdDesktopctl(['run', 'claude', '--task', 'x', '--json'], { ...base(), call: d.call })).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'refused', code: 'flag-off' });
  });

  it('doctor is an alias of capabilities', async () => {
    const d = fakeDesktop();
    expect(await cmdDesktopctl(['doctor', '--json'], { ...base(), call: d.call })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ action: 'capabilities' });
  });
});
