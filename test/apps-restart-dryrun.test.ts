/**
 * `phm apps` restart, --dry-run, the focused-app refusal, the graceful-quit
 * wait and the feed line (RQ-MACAPPSN18XQ8). Every test injects a fake desktop,
 * launcher, probe and feed: nothing here launches, raises or quits an app.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdApps } from '../src/cli/apps-control.js';
import { runAppsControl, type AppsControlDeps, type AppsFeedEntry } from '../src/core/apps-control.js';
import { readLastAppActions, readMacApps, type MacAppsProbe } from '../src/core/apps-known.js';
import type { ToolCall } from '../src/core/verse/desktop-adapters.js';
import { formatAxNode } from '../src/core/verse/verse-mcp-computer.js';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const wrap = (lines: string[]) => ['list', '<untrusted id="a" source="s">', ...lines, '</untrusted id="a">'].join('\n');
const LINE: Record<string, string> = {
  notes: '- Notes (com.apple.Notes): up to full control; this chat holds full control',
  pages: '- Pages (com.apple.iWork.Pages): up to full control [frontmost]',
  phantom: '- Phantom (ai.ashlr.desktop): never available',
  safari: '- Safari (com.apple.Safari): up to full control; this chat holds full control',
};

/** A fake Mac. `closes: false` is an app that ignores Quit, so it never leaves the list. */
function fakeDesktop(running: string[], opts: { closes?: boolean } = {}) {
  const names: string[] = [];
  let live = running.map(k => LINE[k]!);
  const call: ToolCall = async (name, args) => {
    names.push(name);
    if (name === 'computer_list_apps') return ok(wrap(live));
    if (name === 'computer_ax_tree') return ok(wrap([{ ref: 'e1', role: 'AXWindow', title: 'List' }, { ref: 'e2', role: 'AXMenuItem', title: 'Quit' }].map(n => formatAxNode(n))));
    if (name === 'computer_ax_press') { if (opts.closes !== false) live = live.filter(l => !l.includes(`(${String(args.app)})`)); return ok('Pressed'); }
    return { ...ok(`unexpected tool ${name}`), isError: true };
  };
  return { call, names, acted: () => names.includes('computer_ax_press') };
}

/** Claude installed and running, Cursor installed and closed, the rest unknown. */
const probe: MacAppsProbe = {
  async locate(candidates) {
    if (candidates.some(c => c.endsWith('/Claude.app'))) return { path: '/Applications/Claude.app', bundleId: 'com.anthropic.claudefordesktop' };
    if (candidates.some(c => c.endsWith('/Cursor.app'))) return { path: '/Applications/Cursor.app', bundleId: 'com.todesktop.230313mzl4w4u92' };
    if (candidates.some(c => c.endsWith('/Grok.app'))) throw new Error('read refused');
    return null;
  },
  async processes() { return [{ pid: 40, rssKb: 204_800, path: '/Applications/Claude.app/Contents/MacOS/Claude' }]; },
  async frontmost() { return null; },
};

describe('phm apps restart, dry-run and safety', () => {
  let dir: string;
  let lines: string[];
  let feed: AppsFeedEntry[];
  let sleeps: number;
  const launcher = () => ({ open: vi.fn(async () => ({ ok: true as const })), activate: vi.fn(async () => ({ ok: true as const })) });
  const deps = (extra: Partial<AppsControlDeps> = {}): AppsControlDeps => ({
    allowFile: join(dir, 'apps-allow.json'), out: l => lines.push(l), feed: (e) => { feed.push(e); return true; }, needsYou: vi.fn(() => true),
    writesBlocked: () => false, launcher: null, probe, home: '/Users/fixture', sleep: async () => { sleeps += 1; }, ...extra,
  });
  const last = () => JSON.parse(lines.at(-1)!);
  const allow = (apps: unknown[]) => writeFileSync(join(dir, 'apps-allow.json'), JSON.stringify({ apps }));

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'apps-restart-')); lines = []; feed = []; sleeps = 0; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists running, closed and unknown apps with typed kind, process name and last action', async () => {
    const lastActions = () => new Map([['cursor' as const, { action: 'open', outcome: 'done', at: '2026-11-18T10:00:00.000Z' }]]);
    const report = await readMacApps({ probe, home: '/Users/fixture', lastActions });
    expect(report).toMatchObject({ schema: 'phm.apps/2', version: 2, probe: 'partial' });
    const by = (id: string) => report.apps.find(a => a.id === id)!;
    expect(by('claude')).toMatchObject({ kind: 'agent-app', running: true, memoryMb: 200, processName: 'Claude', lastAction: null });
    expect(by('cursor')).toMatchObject({ kind: 'ide', running: false, processName: null, lastAction: { action: 'open', outcome: 'done' } });
    expect(by('grok')).toMatchObject({ installed: null, running: null, reason: expect.stringContaining('read refused') });
    expect([by('phantom').kind, by('safari').kind]).toEqual(['phantom', 'browser']);
  });

  it('reads the last action per app from the feed lines, newest wins, reads ignored', () => {
    const row = (receivedAt: number, body: Record<string, unknown>) => ({ cursor: receivedAt, receivedAt, envelope: { id: 'x', from: 'apps-control', to: 'mason', priority: 'P3' as const, ttl: 1, body: { kind: 'apps-control', ...body } } });
    const actions = readLastAppActions(() => ({ rows: [
      row(2000, { phase: 'result', action: 'focus', app: 'Claude', outcome: 'done' }),
      row(1000, { phase: 'result', action: 'open', app: 'claude', outcome: 'done' }),
      row(3000, { phase: 'result', action: 'status', app: 'claude', outcome: 'done' }),
      row(4000, { phase: 'start', action: 'quit', app: 'safari' }),
      row(5000, { phase: 'result', action: 'open', app: 'Mystery', outcome: 'done' }),
    ] as never }));
    expect([...actions]).toEqual([['claude', { action: 'focus', outcome: 'done', at: '1970-01-01T00:00:02.000Z' }]]);
  });

  it('opens a closed app and focuses a running one through the launcher, one feed line each', async () => {
    const l = launcher();
    expect(await cmdApps(['open', 'cursor', '--json'], deps({ launcher: l }))).toBe(0);
    expect(last()).toMatchObject({ schema: 'phm.apps.action/1', version: 1, ok: true, action: 'open', outcome: 'done', logged: true });
    expect(await cmdApps(['focus', 'claude', '--json'], deps({ launcher: l }))).toBe(0);
    expect(l.open).toHaveBeenCalledWith('com.todesktop.230313mzl4w4u92');
    expect(l.activate).toHaveBeenCalledWith('com.anthropic.claudefordesktop');
    // The work-log line: one result per action, naming the action, the app and how it ended.
    expect(feed.filter(e => e.phase === 'result')).toEqual([
      { phase: 'result', action: 'open', app: 'cursor', outcome: 'done', detail: 'asked macOS to open Cursor.' },
      { phase: 'result', action: 'focus', app: 'claude', outcome: 'done', detail: 'raised Claude.' },
    ]);
  });

  it('never quits or restarts Phantom, listed or not', async () => {
    for (const listed of [false, true]) {
      if (listed) allow([{ name: 'Phantom', bundleId: 'ai.ashlr.desktop' }]);
      for (const action of ['quit', 'restart'] as const) {
        const d = fakeDesktop(['phantom', 'pages']);
        const l = launcher();
        const res = await runAppsControl({ action, app: 'Phantom' }, deps({ call: d.call, launcher: l }));
        expect(res).toMatchObject({ exit: 1, report: { ok: false, outcome: 'refused', code: 'protected' } });
        expect(d.acted()).toBe(false);
        expect(l.open).not.toHaveBeenCalled();
      }
    }
  });

  it('refuses to quit or restart the app in front', async () => {
    allow(['Pages', 'Notes']);
    for (const action of ['quit', 'restart'] as const) {
      const d = fakeDesktop(['notes', 'pages']);
      const res = await runAppsControl({ action, app: 'Pages' }, deps({ call: d.call, launcher: launcher() }));
      expect(res).toMatchObject({ exit: 1, report: { ok: false, outcome: 'refused', code: 'focused', detail: expect.stringContaining('in front') } });
      expect(d.names).toEqual(['computer_list_apps']);
    }
  });

  it('reports unknown when the app has not closed within the quit budget, and does not reopen it', async () => {
    allow(['Notes']);
    for (const action of ['quit', 'restart'] as const) {
      sleeps = 0;
      const d = fakeDesktop(['notes', 'pages'], { closes: false });
      const l = launcher();
      const res = await runAppsControl({ action, app: 'Notes' }, deps({ call: d.call, launcher: l }));
      expect(res).toMatchObject({ exit: 1, report: { schema: 'phm.apps.action/1', ok: false, outcome: 'unknown', code: 'quit-timeout', detail: expect.stringContaining('after 10 s') } });
      expect(res.report).not.toHaveProperty('running');
      expect(sleeps).toBe(40);
      expect(l.open).not.toHaveBeenCalled();
    }
    expect(feed.at(-1)).toMatchObject({ phase: 'result', action: 'restart', outcome: 'unknown' });
  });

  it('restarts an idle app: quit, confirmed closed, then opened by bundle id', async () => {
    allow(['Notes']);
    const d = fakeDesktop(['notes', 'pages']);
    const l = launcher();
    expect(await cmdApps(['restart', 'Notes', '--json'], deps({ call: d.call, launcher: l }))).toBe(0);
    expect(last()).toMatchObject({ ok: true, action: 'restart', outcome: 'done', running: true, logged: true });
    expect(d.acted()).toBe(true);
    expect(l.open).toHaveBeenCalledWith('com.apple.Notes');
    expect(sleeps).toBe(0);
    // Without a launcher nothing is quit: a restart that cannot reopen never starts.
    const stuck = fakeDesktop(['notes', 'pages']);
    expect(await cmdApps(['restart', 'Notes', '--json'], deps({ call: stuck.call }))).toBe(1);
    expect(last()).toMatchObject({ outcome: 'refused', code: 'unsupported' });
    expect(stuck.acted()).toBe(false);
  });

  it('--dry-run prints the exact command, runs nothing and logs nothing', async () => {
    allow(['Notes', 'Pages']);
    const l = launcher();
    expect(await cmdApps(['open', 'cursor', '--dry-run', '--json'], deps({ launcher: l }))).toBe(0);
    expect(last()).toMatchObject({ schema: 'phm.apps.action/1', version: 1, ok: true, outcome: 'dry-run', commands: ['/usr/bin/open -b com.todesktop.230313mzl4w4u92'], logged: false });
    const d = fakeDesktop(['notes', 'pages']);
    expect(await cmdApps(['restart', 'Notes', '--dry-run'], deps({ call: d.call, launcher: l }))).toBe(0);
    expect(lines.at(-1)!.split('\n')).toEqual([
      'Notes: would run 2 steps. Nothing was run.',
      "  press Quit in Notes's menu (computer_ax_press) after an unsaved-work check, then wait up to 10 s for it to close",
      '  /usr/bin/open -b com.apple.Notes',
    ]);
    // A dry run still reports the refusal a real run would hit.
    expect(await cmdApps(['quit', 'Pages', '--dry-run', '--json'], deps({ call: d.call }))).toBe(1);
    expect(last()).toMatchObject({ outcome: 'refused', code: 'focused', logged: false });
    expect(await cmdApps(['quit', 'claude', '--dry-run', '--json'], deps({ call: d.call }))).toBe(1);
    expect(last()).toMatchObject({ outcome: 'refused', code: 'protected' });
    expect(d.names.every(n => n === 'computer_list_apps')).toBe(true);
    expect(l.open).not.toHaveBeenCalled();
    expect(l.activate).not.toHaveBeenCalled();
    expect(feed).toEqual([]);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const args of [['list', '--dry-run'], ['status', 'claude', '--dry-run'], ['request', 'quit', 'Notes', '--dry-run']]) expect(await cmdApps(args, deps())).toBe(2);
    stderr.mockRestore();
  });
});
