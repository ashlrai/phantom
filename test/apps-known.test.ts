/**
 * `phm apps` known-app surface (RQ-APPSN17VQ8). Every test injects the probe
 * and launcher: nothing here reads the real Mac, launches or raises an app.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lastUsedText } from '../src/core/apps-last-used.js';
import { cmdApps } from '../src/cli/apps-control.js';
import type { AppsControlDeps, AppsFeedEntry } from '../src/core/apps-control.js';
import { formatComputerPermissionReport } from '../src/core/verse/verse-mcp-computer.js';
import {
  KNOWN_APPS, PROBE_MISSING_REASON, findKnownApp, formatMacApps, parseLsBundlePath, parseLsLastActivation, parsePsRows, readMacApps, type MacAppsProbe,
} from '../src/core/apps-known.js';

const HOME = '/Users/fixture';
const BUNDLE_IDS: Record<string, string> = {
  'Phantom.app': 'ai.ashlr.desktop', 'Claude.app': 'com.anthropic.claudefordesktop', 'Codex.app': 'com.openai.codex',
  // A real Mac reports this id for ChatGPT.app; the row must still say ChatGPT, matched by path.
  'ChatGPT.app': 'com.openai.codex', 'Cursor.app': 'com.todesktop.230313mzl4w4u92', 'Grok.app': 'ai.x.grok', 'Devin.app': 'ai.cognition.devin', 'Safari.app': 'com.apple.Safari',
};

/** A fixture Mac: which bundles exist, which run (with helpers), which is in front. */
function fixtureProbe(opts: { installed: string[]; running?: string[]; front?: string | null; failPs?: boolean; failFront?: boolean; failLocate?: boolean; focus?: Record<string, number | null | 'bad'>; noLsappinfo?: boolean }): MacAppsProbe & { located: string[][] } {
  const at = (bundle: string) => bundle === 'Safari.app' ? '/System/Cryptexes/App/System/Applications/Safari.app' : `/Applications/${bundle}`;
  const located: string[][] = [];
  return {
    located,
    async locate(candidates) {
      located.push([...candidates]);
      if (opts.failLocate) throw new Error('permission denied');
      const hit = candidates.find(c => opts.installed.some(b => at(b) === c));
      return hit ? { path: hit, bundleId: BUNDLE_IDS[hit.split('/').pop()!] ?? null } : null;
    },
    async processes() {
      if (opts.failPs) throw new Error('ps failed: operation not permitted');
      return [
        { pid: 1, rssKb: 4096, path: '/sbin/launchd' },
        ...(opts.running ?? []).flatMap((b, i) => [
          { pid: 100 + i * 2, rssKb: 102_400, path: `${at(b)}/Contents/MacOS/${b.replace('.app', '')}` },
          { pid: 101 + i * 2, rssKb: 51_200, path: `${at(b)}/Contents/Frameworks/${b.replace('.app', '')} Helper (Renderer).app/Contents/MacOS/${b.replace('.app', '')} Helper (Renderer)` },
        ]),
      ];
    },
    ...(opts.focus || opts.noLsappinfo ? { async lastFocused(bundleId: string) {
      if (opts.noLsappinfo) throw new Error('lsappinfo failed: ENOENT');
      const v = opts.focus?.[bundleId];
      if (v === 'bad') throw new Error('lsappinfo gave an unreadable time');
      return v ?? null;
    } } : {}),
    async frontmost() {
      if (opts.failFront) throw new Error('lsappinfo failed');
      return opts.front ? at(opts.front) : null;
    },
  };
}

const ALL = Object.keys(BUNDLE_IDS);

describe('last used', () => {
  const NOW = Date.parse('2026-11-20T12:00:00Z');
  const run = (focus: Record<string, number | null | 'bad'> | undefined, extra: { noLsappinfo?: boolean } = {}) =>
    readMacApps({ probe: fixtureProbe({ installed: ['Claude.app', 'Codex.app'], running: ['Claude.app', 'Codex.app'], focus, ...extra }), home: HOME })
      .then(r => ({ r, claude: r.apps.find(a => a.id === 'claude')!, codex: r.apps.find(a => a.id === 'codex')! }));

  it('a running focused app gets its time; one never focused says never', async () => {
    const at = NOW - 5 * 60_000;
    const { r, claude, codex } = await run({ 'com.anthropic.claudefordesktop': at, [BUNDLE_IDS['Codex.app']!]: null });
    expect(r.schema).toBe('phm.apps/2');
    expect(claude).toMatchObject({ lastFocus: 'known', lastFocusedAt: new Date(at).toISOString() });
    expect(codex).toMatchObject({ lastFocus: 'never', lastFocusedAt: null });
    expect(formatMacApps(r, NOW)).toContain('last used 5 min ago');
    expect(formatMacApps(r, NOW)).toContain('last used not yet');
  });

  it('lsappinfo missing or a malformed line is unknown, never 0 or now', async () => {
    const missing = await run(undefined, { noLsappinfo: true });
    expect(missing.claude).toMatchObject({ lastFocus: 'unknown', lastFocusedAt: null });
    expect(missing.r.probe).toBe('partial');
    expect(missing.claude.reason).toContain('last used');
    const bad = await run({ 'com.anthropic.claudefordesktop': 'bad' });
    expect(bad.claude).toMatchObject({ lastFocus: 'unknown', lastFocusedAt: null });
    expect(formatMacApps(bad.r, NOW)).toContain('last used unknown');
  });

  it('a probe without lastFocused, a stopped app and no probe at all stay unknown', async () => {
    const none = await readMacApps({ probe: fixtureProbe({ installed: ['Claude.app'], running: [] }), home: HOME });
    expect(none.apps.find(a => a.id === 'claude')).toMatchObject({ lastFocus: 'unknown', lastFocusedAt: null });
    expect((await readMacApps({ probe: null })).apps.every(a => a.lastFocus === 'unknown' && a.lastFocusedAt === null)).toBe(true);
  });

  it('parses lsappinfo lines strictly', () => {
    expect(parseLsLastActivation('"lastActivationTime"=[ NULL ] \n')).toEqual({ state: 'never' });
    expect(parseLsLastActivation('"lastActivationTime"="2026/11/18 14:12:42 ( 5 minutes ago )"')).toEqual({ state: 'at', ms: new Date(2026, 10, 18, 14, 12, 42).getTime() });
    for (const bad of ['', 'nonsense', '"lastActivationTime"=banana', '"lastActivationTime"="2026/13/45 99:99:99"']) expect(parseLsLastActivation(bad)).toEqual({ state: 'unknown' });
  });

  it('relative words', () => {
    const t = (ms: number) => lastUsedText({ lastFocus: 'known', lastFocusedAt: new Date(NOW - ms).toISOString() }, NOW);
    expect([t(10_000), t(5 * 60_000), t(3 * 3_600_000), t(86_400_000), t(3 * 86_400_000)]).toEqual(['just now', '5 min ago', '3 hr ago', '1 day ago', '3 days ago']);
    expect(lastUsedText({ lastFocus: 'unknown', lastFocusedAt: null }, NOW)).toBe('unknown');
  });
});

describe('readMacApps', () => {
  it('all running: one row per known app in catalog order, memory summed with helpers, one obvious action', async () => {
    const report = await readMacApps({ probe: fixtureProbe({ installed: ALL, running: ALL, front: 'Cursor.app' }), home: HOME });
    expect(report.schema).toBe('phm.apps/2');
    expect(report.probe).toBe('ok');
    expect(report.apps.map(a => a.name)).toEqual(['Phantom', 'Claude', 'Codex', 'ChatGPT', 'Cursor', 'Grok', 'Devin', 'Safari']);
    for (const row of report.apps) expect(row).toMatchObject({ installed: true, running: true, memoryMb: 150, reason: null });
    expect(report.apps.find(a => a.id === 'cursor')).toMatchObject({ frontmost: true, action: null });
    expect(report.apps.find(a => a.id === 'claude')).toMatchObject({ frontmost: false, action: 'focus', bundleId: 'com.anthropic.claudefordesktop' });
    expect(report.apps.find(a => a.id === 'chatgpt')).toMatchObject({ name: 'ChatGPT', path: '/Applications/ChatGPT.app' });
    // Phantom never offers itself an action; only Safari may be quit.
    expect(report.apps.find(a => a.id === 'phantom')!.action).toBeNull();
    expect(report.apps.filter(a => a.quit === 'allowed').map(a => a.id)).toEqual(['safari']);
  });

  it('JSON is stable: same input, byte-identical output, fixed key order', async () => {
    const read = () => readMacApps({ probe: fixtureProbe({ installed: ALL, running: ['Claude.app'], front: 'Claude.app' }), home: HOME });
    const a = JSON.stringify(await read());
    expect(JSON.stringify(await read())).toBe(a);
    const row = JSON.parse(a).apps[1];
    expect(Object.keys(row)).toEqual(['id', 'name', 'role', 'installed', 'running', 'frontmost', 'pid', 'memoryMb', 'path', 'bundleId', 'lastFocusedAt', 'lastFocus', 'quit', 'action', 'reason', 'kind', 'processName', 'lastAction']);
    expect(row).toEqual({
      id: 'claude', name: 'Claude', role: 'Assistant', installed: true, running: true, frontmost: true, pid: expect.any(Number), memoryMb: 150,
      path: '/Applications/Claude.app', bundleId: 'com.anthropic.claudefordesktop', lastFocusedAt: null, lastFocus: 'unknown', quit: 'protected', action: null, reason: null,
      kind: 'agent-app', processName: 'Claude', lastAction: null,
    });
  });

  it('none installed: every row is a definite "not installed" with no action', async () => {
    const report = await readMacApps({ probe: fixtureProbe({ installed: [] }), home: HOME });
    expect(report.probe).toBe('ok');
    for (const row of report.apps) expect(row).toMatchObject({ installed: false, running: false, frontmost: false, memoryMb: null, action: null, reason: null });
    expect(formatMacApps(report)).toContain('Claude   not installed');
  });

  it('probe missing: every column is unknown with the reason, never guessed', async () => {
    const report = await readMacApps({ probe: null });
    expect(report).toMatchObject({ probe: 'missing', reason: PROBE_MISSING_REASON });
    expect(report.apps).toHaveLength(KNOWN_APPS.length);
    for (const row of report.apps) expect(row).toMatchObject({ installed: null, running: null, frontmost: null, memoryMb: null, action: null, reason: PROBE_MISSING_REASON });
    expect(formatMacApps(report)).toMatch(/Claude {3}unknown[\s\S]*Unknown: app state can only be read on macOS/);
  });

  it('partial probe: installed is known, running and frontmost stay unknown with the ps error', async () => {
    const report = await readMacApps({ probe: fixtureProbe({ installed: ['Claude.app'], failPs: true, failFront: true }), home: HOME });
    expect(report.probe).toBe('partial');
    expect(report.reason).toContain('operation not permitted');
    expect(report.apps.find(a => a.id === 'claude')).toMatchObject({ installed: true, running: null, frontmost: null, memoryMb: null, action: 'open' });
    expect(report.apps.find(a => a.id === 'claude')!.reason).toMatch(/running state: ps failed/);
    expect(report.apps.find(a => a.id === 'grok')).toMatchObject({ installed: false, running: false, reason: null });
    const locateFailed = await readMacApps({ probe: fixtureProbe({ installed: ALL, failLocate: true }), home: HOME });
    expect(locateFailed.apps[1]).toMatchObject({ installed: null, action: null, reason: expect.stringContaining('permission denied') });
  });

  it('looks in /Applications, ~/Applications and, for Safari, the system cryptex', async () => {
    const probe = fixtureProbe({ installed: ['Safari.app'], running: ['Safari.app'] });
    const report = await readMacApps({ probe, home: HOME });
    expect(probe.located[1]).toEqual(['/Applications/Claude.app', '/Users/fixture/Applications/Claude.app']);
    expect(probe.located[7]).toContain('/System/Cryptexes/App/System/Applications/Safari.app');
    expect(report.apps.find(a => a.id === 'safari')).toMatchObject({ installed: true, running: true, action: 'focus' });
  });

  it('parses ps rows with spaces in the path and lsappinfo bundle paths', () => {
    expect(parsePsRows('  12  2048 /Applications/Claude.app/Contents/Frameworks/Claude Helper (GPU).app/Contents/MacOS/Claude Helper (GPU)\n bad\n')).toEqual([
      { pid: 12, rssKb: 2048, path: '/Applications/Claude.app/Contents/Frameworks/Claude Helper (GPU).app/Contents/MacOS/Claude Helper (GPU)' },
    ]);
    expect(parseLsBundlePath('"LSBundlePath"="/Applications/Cursor.app"\n')).toBe('/Applications/Cursor.app');
    expect(parseLsBundlePath('')).toBeNull();
  });

  it('resolves names, ids and listed bundle ids only', () => {
    expect(findKnownApp(' chatgpt ')?.id).toBe('chatgpt');
    expect(findKnownApp('com.apple.safari')?.id).toBe('safari');
    expect(findKnownApp('Grokbot')).toBeUndefined();
  });
});

describe('phm apps (CLI)', () => {
  let dir: string;
  let lines: string[];
  let feed: AppsFeedEntry[];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'apps-known-')); lines = []; feed = []; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const launcher = () => ({ open: vi.fn(async () => ({ ok: true as const })), activate: vi.fn(async () => ({ ok: true as const })) });
  const deps = (probe: MacAppsProbe | null, extra: Partial<AppsControlDeps> = {}): AppsControlDeps => ({
    allowFile: join(dir, 'apps-allow.json'), out: (l) => lines.push(l), feed: (e) => { feed.push(e); return true; },
    needsYou: vi.fn(() => true), writesBlocked: () => false, launcher: null, probe, home: HOME, ...extra,
  });
  const last = () => JSON.parse(lines.at(-1)!);

  it('bare `phm apps --json` prints the stable report and exits 0, even with no probe', async () => {
    expect(await cmdApps(['--json'], deps(fixtureProbe({ installed: ALL, running: ALL })))).toBe(0);
    expect(last().apps).toHaveLength(8);
    expect(last()).toMatchObject({ schema: 'phm.apps/2', version: 2 });
    // `phm apps status` with no name is the same list.
    expect(await cmdApps(['status', '--json'], deps(fixtureProbe({ installed: ALL, running: ['Devin.app'] })))).toBe(0);
    expect(last().apps.find((a: { id: string }) => a.id === 'devin')).toMatchObject({ running: true, pid: 100, memoryMb: 150, frontmost: false });
    expect(await cmdApps([], deps(null))).toBe(0);
    expect(lines.at(-1)).toContain('Only Safari, its own browser, can be quit.');
  });

  it('protected-app refusal: quit refuses every known app but Safari with a plain reason, and never touches the desktop', async () => {
    const call = vi.fn();
    for (const app of ['Phantom', 'Claude', 'codex', 'ChatGPT', 'Cursor', 'grok', 'Devin']) {
      expect(await cmdApps(['quit', app, '--json'], deps(fixtureProbe({ installed: ALL, running: ALL }), { call }))).toBe(1);
      expect(last()).toMatchObject({ ok: false, outcome: 'refused', code: 'protected', logged: true });
      expect(last().detail).toMatch(/Phantom never quits your apps/);
      expect(await cmdApps(['request', 'quit', app, '--json'], deps(null, { call }))).toBe(1);
      expect(last().code).toBe('protected');
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('an allowlist entry cannot unprotect a known app, matched by name or bundle id', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'apps-allow.json'), JSON.stringify({ apps: [{ name: 'Cursor', actions: ['quit'] }, { name: 'Work editor', bundleId: 'com.anthropic.claudefordesktop' }] }));
    const call = vi.fn();
    for (const app of ['Cursor', 'Work editor']) {
      expect(await cmdApps(['quit', app, '--json'], deps(null, { call }))).toBe(1);
      expect(last()).toMatchObject({ code: 'protected' });
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('Safari quit is allowed and goes through the desktop unsaved-work check', async () => {
    const call = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'not connected' }], isError: true }));
    expect(await cmdApps(['quit', 'Safari', '--json'], deps(null, { call }))).toBe(1);
    expect(last()).toMatchObject({ outcome: 'failed' });
    expect(last().code).not.toBe('protected');
    expect(call).toHaveBeenCalledWith('computer_list_apps', {});
  });

  it('open starts an installed app by its real bundle id; focus raises only a running one', async () => {
    const l = launcher();
    const probe = fixtureProbe({ installed: ALL, running: ['Claude.app'], front: 'Phantom.app' });
    expect(await cmdApps(['open', 'ChatGPT', '--json'], deps(probe, { launcher: l }))).toBe(0);
    expect(l.open).toHaveBeenCalledWith('com.openai.codex');
    expect(await cmdApps(['focus', 'claude', '--json'], deps(probe, { launcher: l }))).toBe(0);
    expect(l.activate).toHaveBeenCalledWith('com.anthropic.claudefordesktop');
    expect(last()).toMatchObject({ outcome: 'done', frontmost: true, logged: true });
    expect(await cmdApps(['focus', 'Cursor', '--json'], deps(probe, { launcher: l }))).toBe(1);
    expect(last()).toMatchObject({ code: 'not-running' });
    expect(l.activate).toHaveBeenCalledOnce();
    expect(feed.filter(e => e.phase === 'start')).toHaveLength(3);
  });

  it('never launches when state is unknown, not installed, writes are stopped, or there is no launcher', async () => {
    const l = launcher();
    expect(await cmdApps(['open', 'Grok', '--json'], deps(fixtureProbe({ installed: [] }), { launcher: l }))).toBe(1);
    expect(last()).toMatchObject({ code: 'not-installed' });
    expect(await cmdApps(['open', 'Claude', '--json'], deps(null, { launcher: l }))).toBe(1);
    expect(last()).toMatchObject({ code: 'unknown' });
    expect(await cmdApps(['focus', 'Claude', '--json'], deps(fixtureProbe({ installed: ALL, failPs: true }), { launcher: l }))).toBe(1);
    expect(last()).toMatchObject({ code: 'unknown' });
    expect(await cmdApps(['open', 'Claude', '--json'], deps(fixtureProbe({ installed: ALL }), { launcher: l, writesBlocked: () => true }))).toBe(1);
    expect(last()).toMatchObject({ code: 'writes-blocked' });
    expect(await cmdApps(['open', 'Claude', '--json'], deps(fixtureProbe({ installed: ALL })))).toBe(1);
    expect(last()).toMatchObject({ code: 'unsupported' });
    expect(l.open).not.toHaveBeenCalled();
    expect(l.activate).not.toHaveBeenCalled();
  });

  it('checks the denylist against the bundle id actually installed, not the catalog name', async () => {
    const l = launcher();
    const probe = fixtureProbe({ installed: ALL });
    const disguised: MacAppsProbe = { ...probe, locate: async (c) => (await probe.locate(c)) && { path: c[0]!, bundleId: 'com.1password.1password' } };
    expect(await cmdApps(['open', 'Grok', '--json'], deps(disguised, { launcher: l }))).toBe(1);
    expect(last()).toMatchObject({ code: 'denied' });
    expect(l.open).not.toHaveBeenCalled();
  });

  it('Phantom itself still goes to needs-you rather than acting', async () => {
    const l = launcher();
    const d = deps(fixtureProbe({ installed: ALL, running: ALL }), { launcher: l });
    expect(await cmdApps(['focus', 'Phantom', '--json'], d)).toBe(3);
    expect(last()).toMatchObject({ outcome: 'needs-you' });
    expect(l.activate).not.toHaveBeenCalled();
  });

  it('status reads the probe and reports unknown as a failure with the reason', async () => {
    expect(await cmdApps(['status', 'Claude', '--json'], deps(fixtureProbe({ installed: ALL, running: ['Claude.app'], front: 'Claude.app' })))).toBe(0);
    expect(last()).toMatchObject({ version: 1, outcome: 'done', detail: 'running, frontmost.', running: true, frontmost: true, pid: 100, memoryMb: 150 });
    expect(await cmdApps(['status', 'Claude', '--json'], deps(null))).toBe(1);
    expect(last()).toMatchObject({ code: 'unknown', detail: expect.stringContaining('only be read on macOS') });
  });
  it('refuses to quit Chrome, the owner\'s browser, by name, bundle id or allowlist entry, without touching the desktop', async () => {
    const { writeFileSync } = await import('node:fs');
    const call = vi.fn();
    for (const app of ['Chrome', 'Google Chrome', 'com.google.Chrome']) {
      expect(await cmdApps(['quit', app, '--json'], deps(null, { call }))).toBe(1);
      expect(last()).toMatchObject({ ok: false, outcome: 'refused', code: 'protected', detail: expect.stringContaining('your own browser') });
    }
    writeFileSync(join(dir, 'apps-allow.json'), JSON.stringify({ apps: [{ name: 'Web', bundleId: 'com.google.Chrome' }, 'Google Chrome Canary'] }));
    expect(await cmdApps(['quit', 'Web', '--json'], deps(null, { call }))).toBe(1);
    expect(last()).toMatchObject({ code: 'protected' });
    expect(call).not.toHaveBeenCalled();
  });

  it('an unknown app name is refused for every action and nothing runs', async () => {
    const l = launcher(); const call = vi.fn();
    for (const action of ['open', 'focus', 'quit', 'status']) {
      expect(await cmdApps([action, 'Photoshop', '--json'], deps(fixtureProbe({ installed: ALL, running: ALL }), { launcher: l, call }))).toBe(1);
      expect(last()).toMatchObject({ version: 1, ok: false, outcome: 'refused', code: 'not-allowlisted', app: 'Photoshop' });
    }
    expect(l.open).not.toHaveBeenCalled(); expect(l.activate).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
  });

  it('permission denied: quit answers needs_permission with the one System Settings path, and presses nothing', async () => {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });
    const desktop = (accessibility: 'missing' | 'granted' | 'unknown') => vi.fn(async (name: string) => {
      if (name === 'computer_list_apps') return text('1 running app:\n- Safari (com.apple.Safari): up to read only');
      // The real formatter writes the line the control reads, so the two cannot drift apart.
      if (name === 'computer_permissions') return text(formatComputerPermissionReport({ supported: true, macos: '26.0', screen: 'granted', accessibility, postEvents: 'granted' }).join('\n'));
      if (name === 'computer_ax_tree') return text('accessibility tree unavailable', true);
      return text(`unexpected ${name}`, true);
    });
    const missing = desktop('missing');
    expect(await cmdApps(['quit', 'Safari', '--json'], deps(null, { call: missing }))).toBe(1);
    expect(last()).toMatchObject({ ok: false, outcome: 'needs_permission', code: 'needs-permission', logged: true,
      permission: { name: 'Accessibility', settingsPath: 'System Settings > Privacy & Security > Accessibility' } });
    expect(last().detail).toContain('System Settings > Privacy & Security > Accessibility');
    expect(missing.mock.calls.map(c => c[0])).not.toContain('computer_ax_press');
    // Granted or unknown is never reported as a missing permission.
    for (const state of ['granted', 'unknown'] as const) {
      await cmdApps(['quit', 'Safari', '--json'], deps(null, { call: desktop(state) }));
      expect(last().outcome).not.toBe('needs_permission');
    }
  });
});

describe('phm apps suggest', () => {
  const lines: string[] = [];
  const last = () => JSON.parse(lines.at(-1)!);
  // Claude 300 MB, Cursor 150 MB (in front), Safari 600 MB, ChatGPT not running.
  const probe = (): MacAppsProbe => {
    const base = fixtureProbe({ installed: ALL, running: ['Claude.app', 'Cursor.app', 'Safari.app', 'Phantom.app'], front: 'Cursor.app' });
    return { ...base, processes: async () => (await base.processes()).map(p => ({ ...p,
      rssKb: p.path.includes('Safari.app') ? p.rssKb * 4 : p.path.includes('Claude.app') ? p.rssKb * 2 : p.rssKb })) };
  };
  const run = (args: string[], p: MacAppsProbe | null = probe()) => cmdApps(['suggest', ...args], { out: (l) => lines.push(l), probe: p, home: HOME, launcher: null });

  it('ranks idle apps by memory, skips the front app and Phantom, and never acts', async () => {
    expect(await run(['--pressure', 'critical', '--json'])).toBe(0);
    expect(last()).toMatchObject({ schema: 'phm.apps.suggest/1', version: 1, pressure: 'critical', needMb: null, totalMb: 900, covers: null });
    expect(last().suggestions).toEqual([
      { id: 'safari', name: 'Safari', pid: expect.any(Number), memoryMb: 600, command: 'phm apps quit safari' },
      { id: 'claude', name: 'Claude', pid: expect.any(Number), memoryMb: 300, command: null },
    ]);
    expect(await run(['--pressure', 'warning'])).toBe(0);
    expect(lines.at(-1)).toMatch(/Safari\s+600 MB\s+→ phm apps quit safari\nClaude\s+300 MB\s+close it yourself\n\nClosing Safari, Claude would free about 900 MB\.\nNothing was quit\./);
  });

  it('stops at the fewest apps that cover --need-mb and says when it falls short', async () => {
    await run(['--need-mb', '500', '--json']);
    expect(last()).toMatchObject({ pressure: 'unknown', needMb: 500, totalMb: 600, covers: true });
    expect(last().suggestions.map((s: { id: string }) => s.id)).toEqual(['safari']);
    await run(['--pressure', 'normal', '--need-mb', '5000', '--json']);
    expect(last()).toMatchObject({ covers: false, totalMb: 900, summary: expect.stringContaining('short of the 5000 MB') });
  });

  it('suggests nothing at normal pressure or when state is unknown, and rejects bad input', async () => {
    await run(['--pressure', 'normal', '--json']);
    expect(last()).toMatchObject({ suggestions: [], summary: 'Memory is fine. Nothing needs to close.' });
    await run(['--pressure', 'critical', '--json'], null);
    expect(last()).toMatchObject({ suggestions: [], summary: 'No idle app to close.', reason: PROBE_MISSING_REASON });
    await run(['--pressure', 'critical', '--json'], fixtureProbe({ installed: ALL, running: ALL, failFront: true }));
    expect(last().suggestions).toEqual([]);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    for (const bad of [['--pressure', 'high'], ['--need-mb', '-5'], ['--need-mb'], ['claude']]) expect(await run(bad)).toBe(2);
    err.mockRestore();
  });
});
