import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdApps, parseAllowlist, type AppsFeedEntry } from '../src/cli/apps-control.js';
import {
  createAppControl, detectUnsavedState, parseAxTree, parseRunningApps, type ToolCall,
} from '../src/core/verse/desktop-adapters.js';
import { formatAxNode } from '../src/core/verse/verse-mcp-computer.js';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const treeText = (nodes: Array<Record<string, unknown>>): string =>
  ['Accessibility tree of X', '<untrusted id="a" source="s">', ...nodes.map((n) => formatAxNode(n)), '</untrusted id="a">'].join('\n');

const APPS = [
  '2 running apps:',
  '<untrusted id="a" source="s">',
  '- Notes (com.apple.Notes): up to full control; this chat holds full control',
  '- Pages (com.apple.iWork.Pages): up to full control [frontmost]',
  '- Phantom (ai.ashlr.desktop): never available',
  '</untrusted id="a">',
].join('\n');

const CLEAN = [
  { ref: 'e1', role: 'AXWindow', title: 'Shopping list' },
  { ref: 'e2', role: 'AXMenuItem', title: 'Quit Notes' },
];
const UNSAVED_BUTTON = [...CLEAN, { ref: 'e3', role: 'AXButton', title: 'Save' }];
const UNSAVED_TITLE = [{ ref: 'e1', role: 'AXWindow', title: 'Draft - Edited' }, { ref: 'e2', role: 'AXMenuItem', title: 'Quit Notes' }];

/** Records every tool name; `tree` is what computer_ax_tree returns. */
function fakeDesktop(tree: Array<Record<string, unknown>> | 'error' | 'ungranted-then' = CLEAN, apps = APPS) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let asked = false;
  const call: ToolCall = async (name, args) => {
    calls.push({ name, args });
    if (name === 'computer_list_apps') return ok(apps);
    if (name === 'computer_request_access') { asked = true; return ok('requested'); }
    if (name === 'computer_ax_tree') {
      if (tree === 'error') return err('Notes is not granted to this chat.');
      if (tree === 'ungranted-then' && !asked) return err('That app is not granted to this chat.');
      return ok(treeText(tree === 'ungranted-then' ? CLEAN : tree));
    }
    if (name === 'computer_ax_press') return ok('Pressed');
    return err(`unexpected tool ${name}`);
  };
  return { call, calls, names: () => calls.map((c) => c.name) };
}

describe('parseRunningApps / detectUnsavedState', () => {
  it('reads name, bundle id and frontmost from computer_list_apps lines', () => {
    expect(parseRunningApps(APPS)).toEqual([
      { name: 'Notes', bundleId: 'com.apple.Notes', frontmost: false },
      { name: 'Pages', bundleId: 'com.apple.iWork.Pages', frontmost: true },
      { name: 'Phantom', bundleId: 'ai.ashlr.desktop', frontmost: false },
    ]);
  });

  it('flags save controls, edited titles and open sheets, and nothing for a clean window', () => {
    const entries = (nodes: Array<Record<string, unknown>>) => parseAxTree(treeText(nodes));
    expect(detectUnsavedState(entries(CLEAN))).toEqual([]);
    expect(detectUnsavedState(entries(UNSAVED_BUTTON))).toEqual(['save-control']);
    expect(detectUnsavedState(entries(UNSAVED_TITLE))).toEqual(['edited-window']);
    expect(detectUnsavedState(entries([{ ref: 'e1', role: 'AXSheet', title: 'Do you want to save' }]))).toEqual(['open-sheet']);
  });
});

describe('createAppControl', () => {
  it('quits a clean app by pressing its Quit menu item, and only uses read and press tools', async () => {
    const d = fakeDesktop();
    const res = await createAppControl(d.call).quit('com.apple.Notes');
    expect(res).toMatchObject({ ok: true, action: 'quit', running: false });
    expect(d.calls.find((c) => c.name === 'computer_ax_press')?.args).toEqual({ app: 'com.apple.Notes', ref: 'e2' });
    expect(new Set(d.names())).toEqual(new Set(['computer_list_apps', 'computer_ax_tree', 'computer_ax_press']));
  });

  it('asks for access once when the chat holds no grant', async () => {
    const d = fakeDesktop('ungranted-then');
    expect((await createAppControl(d.call).quit('Notes')).ok).toBe(true);
    expect(d.names().filter((n) => n === 'computer_request_access')).toHaveLength(1);
  });

  it.each([['save button', UNSAVED_BUTTON], ['edited title', UNSAVED_TITLE]] as const)('refuses to quit with unsaved state (%s) and presses nothing', async (_n, tree) => {
    const d = fakeDesktop([...tree]);
    expect(await createAppControl(d.call).quit('Notes')).toMatchObject({ ok: false, code: 'unsaved-state' });
    expect(d.names()).not.toContain('computer_ax_press');
  });

  it('treats an unreadable tree as unsaved state (fails closed)', async () => {
    const d = fakeDesktop('error');
    expect(await createAppControl(d.call).quit('Notes')).toMatchObject({ ok: false, code: 'unreadable' });
    expect(d.names()).not.toContain('computer_ax_press');
  });

  it('succeeds without acting when the app is not running, and never touches a denied app', async () => {
    const d = fakeDesktop();
    expect(await createAppControl(d.call).quit('Calendar')).toMatchObject({ ok: true, running: false });
    expect(await createAppControl(d.call).quit('ai.ashlr.desktop')).toMatchObject({ ok: false, code: 'denied' });
    expect(d.names()).not.toContain('computer_ax_tree');
  });

  it('reports status from the running list', async () => {
    const d = fakeDesktop();
    const c = createAppControl(d.call);
    expect(await c.status('Pages')).toMatchObject({ ok: true, running: true, frontmost: true });
    expect(await c.status('Mail')).toMatchObject({ ok: true, running: false });
  });

  it('open and focus refuse without a launcher and use it when one is injected', async () => {
    const d = fakeDesktop();
    expect(await createAppControl(d.call).open('com.apple.Calendar')).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await createAppControl(d.call).focus('Notes')).toMatchObject({ ok: false, code: 'unsupported' });
    const launcher = { open: vi.fn(async () => ({ ok: true as const })), activate: vi.fn(async () => ({ ok: true as const })) };
    const c = createAppControl(d.call, { launcher });
    expect(await c.open('com.apple.Calendar')).toMatchObject({ ok: true });
    expect(await c.focus('Notes')).toMatchObject({ ok: true, frontmost: true });
    expect(await c.focus('Calendar')).toMatchObject({ ok: false, code: 'not-running' });
    expect(await c.open('ai.ashlr.desktop')).toMatchObject({ ok: false, code: 'denied' });
    expect(launcher.open).toHaveBeenCalledWith('com.apple.Calendar');
    expect(launcher.activate).toHaveBeenCalledWith('com.apple.Notes');
  });
});

describe('parseAllowlist', () => {
  it('accepts names, bundle ids and objects, in an object or a bare array', () => {
    expect(parseAllowlist('{"apps":["Notes","com.apple.Safari",{"name":"Pages","bundleId":"com.apple.iWork.Pages"}]}')).toEqual({
      ok: true,
      apps: [{ name: 'Notes', bundleId: null }, { name: 'com.apple.Safari', bundleId: 'com.apple.Safari' }, { name: 'Pages', bundleId: 'com.apple.iWork.Pages' }],
    });
    expect(parseAllowlist('["Notes"]')).toMatchObject({ ok: true });
  });

  it.each(['nope', '{"apps":"Notes"}', '{"apps":[1]}', '{"apps":["a\\nb"]}', '{"apps":[{"name":"X","bundleId":"bad id"}]}'])('rejects %s', (text) => {
    expect(parseAllowlist(text).ok).toBe(false);
  });
});

describe('phm apps', () => {
  let dir: string;
  let allowFile: string;
  let lines: string[];
  let feed: AppsFeedEntry[];
  const base = () => ({ allowFile, out: (l: string) => lines.push(l), feed: (e: AppsFeedEntry) => { feed.push(e); return true; }, needsYou: vi.fn(() => true) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apps-control-'));
    allowFile = join(dir, 'apps-allow.json');
    lines = [];
    feed = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const allow = (apps: unknown[]) => writeFileSync(allowFile, JSON.stringify({ apps }));

  it('prints usage for --help anywhere and exits 0', async () => {
    expect(await cmdApps(['quit', '--help'], base())).toBe(0);
    expect(lines[0]).toContain('phm apps list');
  });

  it('rejects unknown verbs, missing targets and control characters with exit 2', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const args of [[], ['dance'], ['quit'], ['list', 'x'], ['quit', 'No\nPe'], ['quit', '--json']]) expect(await cmdApps(args, base())).toBe(2);
    stderr.mockRestore();
  });

  it('is empty by default: a missing file lists nothing and every action is refused without touching the desktop', async () => {
    const d = fakeDesktop();
    expect(await cmdApps(['list', '--json'], { ...base(), call: d.call })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, action: 'list', apps: [] });
    for (const verb of ['open', 'quit', 'focus', 'status']) {
      lines = [];
      expect(await cmdApps([verb, 'Notes', '--json'], { ...base(), call: d.call })).toBe(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, outcome: 'refused', code: 'not-allowlisted', logged: true });
    }
    expect(d.names().filter((n) => n !== 'computer_list_apps')).toEqual([]);
    expect(feed.filter((e) => e.phase === 'result' && e.outcome === 'refused')).toHaveLength(4);
  });

  it('lists only allowlisted apps with live state', async () => {
    allow(['Notes', 'Mail']);
    const d = fakeDesktop();
    expect(await cmdApps(['list', '--json'], { ...base(), call: d.call })).toBe(0);
    const out = JSON.parse(lines[0]!);
    expect(out.apps).toEqual([
      { name: 'Notes', bundleId: null, running: true, frontmost: false },
      { name: 'Mail', bundleId: null, running: false, frontmost: false },
    ]);
    expect(JSON.stringify(out)).not.toContain('Pages');
  });

  it('quits an allowlisted clean app and logs start and result to the feed', async () => {
    allow([{ name: 'Notes', bundleId: 'com.apple.Notes' }]);
    const d = fakeDesktop();
    expect(await cmdApps(['quit', 'notes', '--json'], { ...base(), call: d.call })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true, action: 'quit', outcome: 'done', logged: true });
    expect(feed.map((e) => [e.phase, e.action, e.outcome])).toEqual([['start', 'quit', undefined], ['result', 'quit', 'done']]);
    expect(d.names()).toContain('computer_ax_press');
  });

  it('routes a quit with unsaved state to needs-you (exit 3) and does not press Quit', async () => {
    allow(['Notes']);
    const d = fakeDesktop(UNSAVED_BUTTON);
    const deps = base();
    expect(await cmdApps(['quit', 'Notes', '--json'], { ...deps, call: d.call })).toBe(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, outcome: 'needs-you', code: 'unsaved-state' });
    expect(deps.needsYou).toHaveBeenCalledTimes(1);
    expect(deps.needsYou.mock.calls[0]![0]).toContain('unsaved work');
    expect(d.names()).not.toContain('computer_ax_press');
  });

  it('does not run an action whose feed entry cannot be written', async () => {
    allow(['Notes']);
    const d = fakeDesktop();
    expect(await cmdApps(['quit', 'Notes', '--json'], { ...base(), call: d.call, feed: () => false })).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'refused', code: 'feed-unavailable', logged: false });
    expect(d.calls).toEqual([]);
  });

  it('fails closed when no desktop connection is supplied', async () => {
    allow(['Notes']);
    expect(await cmdApps(['status', 'Notes', '--json'], base())).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, outcome: 'failed' });
    expect(JSON.parse(lines[0]!).detail).toContain('not connected');
  });

  it('refuses open and focus when no launcher is connected', async () => {
    allow([{ name: 'Calendar', bundleId: 'com.apple.iCal' }, 'Notes']);
    const d = fakeDesktop();
    expect(await cmdApps(['open', 'Calendar', '--json'], { ...base(), call: d.call })).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'refused', code: 'unsupported' });
    lines = [];
    expect(await cmdApps(['focus', 'Notes', '--json'], { ...base(), call: d.call })).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'refused', code: 'unsupported' });
  });

  it('reports a bad allowlist file as a failure', async () => {
    writeFileSync(allowFile, '{');
    expect(await cmdApps(['list', '--json'], base())).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false });
  });

  it('keeps newlines in an app name out of the needs-you line', async () => {
    allow([{ name: 'Weird App', bundleId: 'com.example.weird' }]);
    const apps = '- Weird App (com.example.weird): up to full control';
    const d = fakeDesktop(UNSAVED_BUTTON, apps);
    const deps = base();
    await cmdApps(['quit', 'Weird App'], { ...deps, call: d.call });
    expect(deps.needsYou.mock.calls[0]![0]).not.toMatch(/[\n\r]/);
  });
});
