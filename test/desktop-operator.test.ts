import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { cmdDesktop, parseDesktopInstallArgs } from '../src/cli/desktop.js';
import { cmdDesktopOperator } from '../src/cli/desktop-operator.js';
import { desktopSessions } from '../src/core/desktop/desktop-sessions.js';
import { deliverScreenshot, desktopOperatorTools } from '../src/core/desktop/operator-mcp.js';
import {
  runDesktopOperator,
  scrubOperatorJson,
  type DesktopSurface,
  type DesktopWindow,
  type OperatorDeps,
  type RunningDesktopApp,
} from '../src/core/desktop/operator.js';
import {
  ACCESSIBILITY_PANE,
  ACCESSIBILITY_SETTINGS_URL,
  COMPUTER_DENIED_SETTINGS_TITLES,
  OPERATOR_ROSTER,
  SCREEN_RECORDING_PANE,
  SCREEN_RECORDING_SETTINGS_URL,
  operatorDenyReason,
} from '../src/core/desktop/operator-policy.js';
import { parseHelperPayload, resolveDesktopOperatorBinary } from '../src/core/desktop/operator-surface.js';
import { validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { COMPUTER_TERMINAL_IDE_BUNDLES } from '../src/core/verse/computer-types.js';

const cursor: RunningDesktopApp = { name: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92', pid: 11 };
const phantom: RunningDesktopApp = { name: 'Phantom', bundleId: 'ai.ashlr.desktop', pid: 12 };
const terminal: RunningDesktopApp = { name: 'Terminal', bundleId: 'com.apple.Terminal', pid: 13 };
const keychain: RunningDesktopApp = { name: 'Keychain Access', bundleId: 'com.apple.keychainaccess', pid: 14 };
const messages: RunningDesktopApp = { name: 'Messages', bundleId: 'com.apple.MobileSMS', pid: 15 };
const passwords: RunningDesktopApp = { name: '1Password', bundleId: 'com.1password.1password', pid: 16 };

const cursorWindow: DesktopWindow = {
  app: 'Cursor', bundleId: cursor.bundleId, title: 'Fix the roster', windowId: 4, focused: true, pid: cursor.pid,
};
const messagesWindow: DesktopWindow = {
  app: 'Messages', bundleId: messages.bundleId, title: 'Mason', windowId: 9, focused: false, pid: messages.pid,
};

function mockSurface(input: {
  apps?: RunningDesktopApp[];
  windows?: DesktopWindow[];
  grants?: { accessibility: boolean; screenRecording: boolean };
  order?: string[];
  text?: string;
} = {}): DesktopSurface {
  const order = input.order ?? [];
  const grants = input.grants ?? { accessibility: true, screenRecording: true };
  const apps = input.apps ?? [cursor, phantom, terminal, keychain, messages, passwords];
  const windows = input.windows ?? [cursorWindow, messagesWindow];
  return {
    async permissions() {
      order.push('permissions');
      return grants;
    },
    async listApps() {
      order.push('list');
      return { ok: true, value: apps };
    },
    async windows() {
      order.push('windows');
      return { ok: true, value: windows };
    },
    async focus() {
      order.push('focus');
      return { ok: true, value: { focused: true } };
    },
    async read() {
      order.push('read');
      return { ok: true, value: { source: 'ax', text: input.text ?? 'hello from Cursor', truncated: false, nodes: 3 } };
    },
    async scroll() {
      order.push('scroll');
      return { ok: true, value: { scrolled: true } };
    },
    async type() {
      order.push('type');
      return { ok: true, value: { typed: 4 } };
    },
    async click() {
      order.push('click');
      return { ok: true, value: { clicked: true } };
    },
    async screenshot() {
      order.push('screenshot');
      return { ok: true, value: { mime: 'image/png', base64: 'abc', width: 10, height: 8, ocrText: 'seen' } };
    },
  };
}

function deps(surface: DesktopSurface, extra: OperatorDeps = {}): OperatorDeps {
  return {
    platform: 'darwin',
    surface,
    killed: () => false,
    commsPaused: () => false,
    postIntent: () => { throw new Error('bus should stay idle for this call'); },
    id: () => 'desktop-op-test',
    ...extra,
  };
}

describe('desktop operator policy reuses computer-use rules', () => {
  it('keeps the permission URLs and settings titles aligned with the existing desktop path', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const rust = readFileSync(join(root, 'desktop/src-tauri/src/computer.rs'), 'utf8');
    const swift = readFileSync(join(root, 'tools/desktop-operator/main.swift'), 'utf8');
    expect(rust).toContain(`"${ACCESSIBILITY_SETTINGS_URL}"`);
    expect(rust).toContain(`"${SCREEN_RECORDING_SETTINGS_URL}"`);
    expect(swift).toContain(`"${ACCESSIBILITY_PANE}"`);
    expect(swift).toContain(`"${SCREEN_RECORDING_PANE}"`);
    for (const title of COMPUTER_DENIED_SETTINGS_TITLES) expect(swift).toContain(`"${title}"`);
    expect(COMPUTER_TERMINAL_IDE_BUNDLES).toContain('com.todesktop.230313mzl4w4u92');
    expect(OPERATOR_ROSTER.map((app) => app.id)).toEqual(['phantom', 'devin', 'codex', 'claude', 'grok', 'cursor']);
  });

  it('allows Phantom and Cursor typing, and refuses keychain, Messages and other terminals', () => {
    expect(operatorDenyReason({ name: 'Phantom', bundleId: 'ai.ashlr.desktop', verb: 'type' })).toBeNull();
    expect(operatorDenyReason({ name: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92', verb: 'type' })).toBeNull();
    expect(operatorDenyReason({ name: 'Terminal', bundleId: 'com.apple.Terminal', verb: 'type' })).toEqual(expect.any(String));
    expect(operatorDenyReason({ name: 'Terminal', bundleId: 'com.apple.Terminal', verb: 'read' })).toBeNull();
    expect(operatorDenyReason({ name: 'Keychain Access', bundleId: 'com.apple.keychainaccess', verb: 'read' })).toEqual(expect.any(String));
    expect(operatorDenyReason({ name: 'Messages', bundleId: 'com.apple.MobileSMS', verb: 'read' })).toEqual(expect.any(String));
    expect(operatorDenyReason({ name: '1Password', bundleId: 'com.1password.1password', verb: 'read' })).toEqual(expect.any(String));
    expect(operatorDenyReason({ name: 'System Settings', bundleId: 'com.apple.systempreferences', windowTitle: 'Privacy & Security', verb: 'read' })).toEqual(expect.any(String));
  });
});

describe('runDesktopOperator', () => {
  it('lists apps and reads a window without posting a bus intent', async () => {
    const order: string[] = [];
    const surface = mockSurface({ order, text: 'hello from Cursor' });
    const listed = await runDesktopOperator({ verb: 'list-apps' }, deps(surface));
    const read = await runDesktopOperator({ verb: 'read', app: 'Cursor' }, deps(surface));
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const apps = listed.data['apps'] as Array<{ name: string; operable: boolean }>;
      expect(apps.find((app) => app.name === 'Cursor')?.operable).toBe(true);
      expect(apps.find((app) => app.name === 'Keychain Access')?.operable).toBe(false);
    }
    expect(read).toMatchObject({ ok: true, verb: 'read', data: { text: 'hello from Cursor', source: 'ax', untrusted: true } });
    expect(order).toEqual(['permissions', 'list', 'permissions', 'list', 'read']);
  });

  it('returns permission_required with the Accessibility pane and does not list apps', async () => {
    const order: string[] = [];
    const surface = mockSurface({ order, grants: { accessibility: false, screenRecording: true } });
    const result = await runDesktopOperator({ verb: 'list-apps' }, deps(surface));
    expect(result).toMatchObject({
      ok: false,
      code: 'permission_required',
      permission: 'accessibility',
      pane: ACCESSIBILITY_PANE,
      binary: 'desktop-operator',
    });
    expect(order).toEqual(['permissions']);
  });

  it('names the Screen Recording pane when a screenshot cannot be taken', async () => {
    const order: string[] = [];
    const surface = mockSurface({ order, grants: { accessibility: true, screenRecording: false } });
    const result = await runDesktopOperator({ verb: 'screenshot', app: 'Cursor' }, deps(surface));
    expect(result).toMatchObject({
      ok: false,
      code: 'permission_required',
      permission: 'screen_recording',
      pane: SCREEN_RECORDING_PANE,
      legacyPane: 'Screen Recording',
    });
    expect(order).toEqual(['permissions']);
  });

  it('posts a bus intent before type, and skips the write when the bus refuses', async () => {
    const order: string[] = [];
    const surface = mockSurface({ order });
    const posted: unknown[] = [];
    const secret = `sk-${'abcdefghijklmnopqrstuvwxyz'}`;
    const ok = await runDesktopOperator({ verb: 'type', app: 'Cursor', window: secret, text: secret }, deps(surface, {
      postIntent: (envelope) => {
        order.push('intent');
        posted.push(envelope);
        return { status: 'posted' };
      },
    }));
    expect(ok.ok).toBe(true);
    expect(order).toEqual(['permissions', 'list', 'intent', 'type']);
    const envelope = posted[0];
    expect(validateBusEnvelope(envelope).ok).toBe(true);
    const body = JSON.stringify(envelope);
    expect(body).not.toContain(secret);
    expect(body).toContain('desktop.intent');
    expect(body).toContain('[REDACTED]');

    const blocked: string[] = [];
    const second = mockSurface({ order: blocked });
    const refused = await runDesktopOperator({ verb: 'click', app: 'Cursor', x: 1, y: 2 }, deps(second, {
      postIntent: () => ({ status: 'unavailable' }),
    }));
    expect(refused).toMatchObject({ ok: false, code: 'intent_not_posted' });
    expect(blocked).toEqual(['permissions', 'list']);
  });

  it('stops writes when KILL is on or comms are paused, and still allows a read', async () => {
    const killedOrder: string[] = [];
    const killed = await runDesktopOperator({ verb: 'type', app: 'Cursor', text: 'hi' }, deps(mockSurface({ order: killedOrder }), {
      killed: () => true,
    }));
    expect(killed).toMatchObject({ ok: false, code: 'killed' });
    expect(killedOrder).toEqual([]);

    const pausedOrder: string[] = [];
    const paused = await runDesktopOperator({ verb: 'focus', app: 'Phantom' }, deps(mockSurface({ order: pausedOrder }), {
      commsPaused: () => true,
    }));
    expect(paused).toMatchObject({ ok: false, code: 'comms_paused' });
    expect(pausedOrder).toEqual([]);

    const read = await runDesktopOperator({ verb: 'read', app: 'Phantom' }, deps(mockSurface(), { killed: () => true }));
    expect(read.ok).toBe(true);
  });

  it('refuses keychain, other terminals, Messages windows and chat.db targets', async () => {
    const order: string[] = [];
    const surface = mockSurface({ order });
    const base = deps(surface, { postIntent: () => ({ status: 'posted' }) });
    expect(await runDesktopOperator({ verb: 'type', app: 'Keychain Access', text: 'nope' }, base)).toMatchObject({ code: 'denied' });
    expect(await runDesktopOperator({ verb: 'type', app: 'Terminal', text: 'ls' }, base)).toMatchObject({ code: 'denied' });
    expect(await runDesktopOperator({ verb: 'type', app: '1Password', text: 'nope' }, base)).toMatchObject({ code: 'denied' });
    expect(order.filter((step) => step === 'type')).toEqual([]);
    const windows = await runDesktopOperator({ verb: 'windows' }, deps(surface));
    expect(windows.ok).toBe(true);
    if (windows.ok) {
      const titles = (windows.data['windows'] as DesktopWindow[]).map((window) => window.app);
      expect(titles).toContain('Cursor');
      expect(titles).not.toContain('Messages');
    }
    expect(await runDesktopOperator({ verb: 'read', app: 'Cursor', window: 'Library/Messages/chat.db' }, deps(surface))).toMatchObject({ code: 'forbidden_store' });
  });

  it('reports unsupported off macOS and a missing helper on macOS', async () => {
    const unsupported = await runDesktopOperator({ verb: 'doctor' }, { platform: 'linux' });
    expect(unsupported).toMatchObject({ ok: false, code: 'unsupported' });
    const missing = await runDesktopOperator({ verb: 'list-apps' }, {
      platform: 'darwin',
      exists: () => false,
      env: {},
      cwd: '/tmp/none',
    });
    expect(missing).toMatchObject({ ok: false, code: 'helper_missing', binary: 'desktop-operator' });
    expect(JSON.stringify(missing)).toContain(ACCESSIBILITY_PANE);
  });
});

describe('desktopSessions roster hook', () => {
  it('returns visible sessions and prefers an official export for last activity', async () => {
    const surface = mockSurface();
    const result = await desktopSessions({
      ...deps(surface),
      sessionExports: async () => [{
        app: 'Devin',
        bundleId: 'ai.cognition.devin',
        windowTitle: 'Local chat',
        sessionTitle: 'Local chat',
        lastActivity: '2026-11-09T05:00:00Z',
      }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.map((session) => session.app)).toEqual(['Devin', 'Cursor']);
      expect(result.sessions[0]).toMatchObject({ rosterApp: 'devin', lastActivity: '2026-11-09T05:00:00Z', sessionTitle: 'Local chat' });
      expect(result.sessions[1]).toMatchObject({ rosterApp: 'cursor', windowTitle: 'Fix the roster', lastActivity: null });
    }
  });
});

describe('phm desktop operator CLI', () => {
  it('keeps desktop install parsing and prints scrubbed JSON for a read', async () => {
    expect(parseDesktopInstallArgs(['install'])).toEqual({ apply: false });
    const logs: string[] = [];
    const secret = `sk-${'abcdefghijklmnopqrstuvwxyz'}`;
    const code = await cmdDesktop(['read', '--app', 'Cursor', '--json'], undefined, undefined, {
      ...deps(mockSurface({ text: `hello ${secret}` })),
      log: (line) => logs.push(line),
    });
    expect(code).toBe(0);
    const body = JSON.parse(logs[0] ?? '{}') as { data: { text: string } };
    expect(body.data.text).toContain('hello');
    expect(body.data.text).toContain('[REDACTED]');
    expect(body.data.text).not.toContain(secret);
    expect(scrubOperatorJson({ base64: 'a'.repeat(80), text: secret })).toMatchObject({ base64: 'a'.repeat(80) });
  });

  it('exits 1 with permission_required JSON and exits 0 for operator help', async () => {
    const logs: string[] = [];
    const code = await cmdDesktopOperator(['doctor', '--json'], {
      ...deps(mockSurface({ grants: { accessibility: false, screenRecording: false } })),
      log: (line) => logs.push(line),
    });
    expect(code).toBe(1);
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ code: 'permission_required', pane: ACCESSIBILITY_PANE });
    const help = await cmdDesktopOperator(['list-apps', '--help'], { log: () => undefined });
    expect(help).toBe(0);
    const usage = await cmdDesktopOperator(['click', '--app', 'Cursor'], { error: () => undefined });
    expect(usage).toBe(2);
  });
});

describe('desktop operator MCP tools', () => {
  it('registers the same verbs with read and append safety', () => {
    const names = desktopOperatorTools.map((tool) => tool.name);
    expect(names).toEqual([
      'desktop_list_apps', 'desktop_windows', 'desktop_read', 'desktop_screenshot', 'desktop_doctor',
      'desktop_focus', 'desktop_scroll', 'desktop_type', 'desktop_click',
    ]);
    for (const name of ['desktop_list_apps', 'desktop_read', 'desktop_doctor', 'desktop_screenshot']) {
      expect(nativeToolSafety(name)).toBe('read');
      expect(listNativeTools().some((tool) => tool.name === name)).toBe(true);
    }
    for (const name of ['desktop_focus', 'desktop_scroll', 'desktop_type', 'desktop_click']) {
      expect(nativeToolSafety(name)).toBe('append');
    }
    const delivered = deliverScreenshot({
      ok: true,
      verb: 'screenshot',
      data: { base64: Buffer.from('png').toString('base64'), ocrText: 'seen', mime: 'image/png' },
    }, () => '/private/shot.png');
    expect(delivered.ok).toBe(true);
    if (delivered.ok) {
      expect(delivered.data['path']).toBe('/private/shot.png');
      expect(delivered.data['base64']).toBeUndefined();
    }
  });
});

describe('helper protocol', () => {
  it('parses permission_required and ignores a configured binary that is absent', () => {
    expect(parseHelperPayload('{"ok":false,"code":"permission_required","permission":"accessibility"}')).toEqual({
      ok: false,
      code: 'permission_required',
      permission: 'accessibility',
    });
    expect(parseHelperPayload('nope')).toMatchObject({ ok: false, code: 'failed' });
    expect(resolveDesktopOperatorBinary(
      { PHANTOM_DESKTOP_OPERATOR: '/missing/desktop-operator', HOME: '/tmp/home' },
      '/repo',
      (path) => path === '/tmp/home/.ashlr/bin/desktop-operator',
    )).toBeNull();
    expect(resolveDesktopOperatorBinary({ HOME: '/tmp/home' }, '/repo', (path) => path.endsWith('/.ashlr/bin/desktop-operator'))).toMatch(/desktop-operator$/);
  });
});
