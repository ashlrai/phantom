import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileDirAllowed, readSite, usageBrowserDir, type BrowserSession } from '../src/core/usage/live/browser.js';
import { evaluateAlerts, nextWakeMs, renderFirstReadings, runLiveUsageTick } from '../src/core/usage/live/engine.js';
import { USAGE_SITES, bindingWindow, needsSignin, parseResetPhrase, parseVisibleWindows } from '../src/core/usage/live/sites.js';
import { presentUsageSensors, type UsageSensorReading } from '../src/core/usage/sensor-reading.js';
import { cmdUsageLive } from '../src/cli/usage-live.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const claude = USAGE_SITES.find(s => s.id === 'claude')!;
const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'usage-live-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeBrowser(pages: Record<string, { url?: string; text?: string; fail?: boolean }>): BrowserSession & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async newPage() {
      let current = '';
      return {
        async goto(url: string) { current = url; opened.push(url); if (pages[url]?.fail) throw new Error('boom'); },
        url: () => pages[current]?.url ?? current,
        visibleText: async () => pages[current]?.text ?? '',
        close: async () => {},
      };
    },
    close: async () => {},
  };
}

const CLAUDE_TEXT = 'Plan usage limits\n\nCurrent session\nResets in 2 hr 15 min\n37% used\n\nWeekly limits\nResets Fri 9:00 AM\n62% used\n';

describe('visible-text parsing', () => {
  it('reads relative and weekday reset phrases', () => {
    expect(parseResetPhrase('Resets in 2 hr 15 min', NOW)).toBe(new Date(NOW + 135 * 60_000).toISOString());
    expect(parseResetPhrase('Resets in 3 days', NOW)).toBe(new Date(NOW + 3 * 86_400_000).toISOString());
    const fri = parseResetPhrase('Resets Fri 9:00 AM', NOW)!;
    expect(new Date(fri).getDay()).toBe(5);
    expect(Date.parse(fri)).toBeGreaterThan(NOW);
    expect(parseResetPhrase('Resets Nov 14, 9:00 AM', NOW)).not.toBeNull();
    expect(parseResetPhrase('Resets soonish', NOW)).toBeNull();
    expect(parseResetPhrase('Resets in 0 min', NOW)).toBeNull();
  });
  it('pairs each percent with its own block and the fullest window binds', () => {
    const windows = parseVisibleWindows('percent', CLAUDE_TEXT, NOW);
    expect(windows.map(w => w.used)).toEqual([37, 62]);
    expect(windows[0]!.resetAt).toBe(new Date(NOW + 135 * 60_000).toISOString());
    expect(bindingWindow(windows)!.used).toBe(62);
  });
  it('rejects out of range, unlabeled and oversize text', () => {
    expect(parseVisibleWindows('percent', '140% used', NOW)).toEqual([]);
    expect(parseVisibleWindows('percent', 'You have 40 percent left', NOW)).toEqual([]);
    expect(parseVisibleWindows('percent', 'x'.repeat(200_001), NOW)).toEqual([]);
    expect(bindingWindow([])).toBeNull();
  });
  it('reads an ACU pair', () => {
    const w = parseVisibleWindows('acu', 'Billing cycle\n1,250.5 of 2,000 ACUs\nResets in 5 days', NOW);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ used: 1250.5, limit: 2000 });
  });
});

describe('sign-in detection and browser reads', () => {
  it('flags a redirect off host or onto a login path', () => {
    expect(needsSignin(claude, 'https://claude.ai/login', '', [])).toBe(true);
    expect(needsSignin(claude, 'https://accounts.google.com/x', '', [])).toBe(true);
    expect(needsSignin(claude, 'not a url', '', [])).toBe(true);
    expect(needsSignin(claude, claude.url, 'Sign in to continue', [])).toBe(true);
    expect(needsSignin(claude, claude.url, 'Sign in', [{ label: 'a', used: 1, limit: 100, resetAt: null }])).toBe(false);
  });
  it('returns ok, needs-signin or unreadable and never throws', async () => {
    const ok = await readSite(claude, fakeBrowser({ [claude.url]: { text: CLAUDE_TEXT } }), NOW);
    expect(ok).toMatchObject({ status: 'ok', used: 62, limit: 100 });
    const signin = await readSite(claude, fakeBrowser({ [claude.url]: { url: 'https://claude.ai/login', text: 'Sign in' } }), NOW);
    expect(signin).toEqual({ status: 'needs-signin', site: 'claude', label: claude.label, url: claude.url });
    expect(await readSite(claude, fakeBrowser({ [claude.url]: { text: 'Hello' } }), NOW)).toMatchObject({ status: 'unreadable', reason: 'no-visible-numbers' });
    expect(await readSite(claude, fakeBrowser({ [claude.url]: { fail: true } }), NOW)).toMatchObject({ status: 'unreadable', reason: 'navigation-failed' });
  });
  it('confines the profile to the usage browser dir and refuses Codex homes', () => {
    const home = '/Users/x';
    expect(profileDirAllowed(usageBrowserDir(home), home)).toBe(true);
    expect(profileDirAllowed(`${usageBrowserDir(home)}/p1`, home)).toBe(true);
    expect(profileDirAllowed('/Users/x/.codex', home)).toBe(false);
    expect(profileDirAllowed('/Users/x/.ashlr-runs/usage-browser/../../.codex-2', home)).toBe(false);
    expect(profileDirAllowed('/Users/x/Library/Application Support/Google/Chrome', home)).toBe(false);
    expect(profileDirAllowed('relative', home)).toBe(false);
  });
});

function lane(percent: number, resetAt: string, burn?: number): ReturnType<typeof presentUsageSensors> {
  const rows: UsageSensorReading[] = [];
  const at = (offsetMin: number, used: number): UsageSensorReading => ({ lane: 'codex-personal', observedAt: new Date(NOW - offsetMin * 60_000).toISOString(),
    source: 'codex-app-server', staleAfter: new Date(NOW - offsetMin * 60_000 + 15 * 60_000 + (offsetMin > 0 ? 3_600_000 : 0)).toISOString(), used, limit: 100, unit: 'percent', resetAt });
  if (burn !== undefined) rows.push(at(60, percent - burn));
  rows.push(at(0, percent));
  return presentUsageSensors(rows, NOW);
}

describe('alerts', () => {
  const reset = new Date(NOW + 3 * 3_600_000).toISOString();
  it('fires 80 once, then 95 once, per reset window', () => {
    let state = { fired: {} as Record<string, string> };
    let r = evaluateAlerts(lane(81, reset).lanes, [], state, NOW);
    expect(r.alerts.map(a => a.level)).toEqual(['cap-80']);
    state = r.state;
    expect(evaluateAlerts(lane(85, reset).lanes, [], state, NOW).alerts).toEqual([]);
    r = evaluateAlerts(lane(96, reset).lanes, [], state, NOW);
    expect(r.alerts.map(a => a.level)).toEqual(['cap-95']);
    expect(evaluateAlerts(lane(99, reset).lanes, [], r.state, NOW).alerts).toEqual([]);
    const next = new Date(NOW + 200 * 3_600_000).toISOString();
    expect(evaluateAlerts(lane(81, next).lanes, [], r.state, NOW).alerts.map(a => a.level)).toEqual(['cap-80']);
  });
  it('a jump straight past 95 fires only 95', () => {
    expect(evaluateAlerts(lane(97, reset).lanes, [], { fired: {} }, NOW).alerts.map(a => a.level)).toEqual(['cap-95']);
  });
  it('projects an allowance expiring unspent near reset, and stays quiet when far or on pace', () => {
    const soon = lane(20, reset, 2);
    expect(soon.lanes.find(l => l.lane === 'codex-personal')!.burnRate).toBe(2);
    expect(evaluateAlerts(soon.lanes, [], { fired: {} }, NOW).alerts.map(a => a.level)).toEqual(['expire-unspent']);
    const far = new Date(NOW + 100 * 3_600_000).toISOString();
    expect(evaluateAlerts(lane(20, far, 2).lanes, [], { fired: {} }, NOW).alerts).toEqual([]);
    expect(evaluateAlerts(lane(60, reset, 12).lanes, [], { fired: {} }, NOW).alerts).toEqual([]);
  });
  it('unknown and stale lanes raise nothing', () => {
    expect(evaluateAlerts(presentUsageSensors([], NOW).lanes, [], { fired: {} }, NOW).alerts).toEqual([]);
  });
  it('covers pools the sensor schema lacks', () => {
    const extra = { site: 'zai' as const, budgetLane: 'zai', used: 90, limit: 100, unit: 'percent' as const, resetAt: reset, observedAt: new Date(NOW).toISOString() };
    expect(evaluateAlerts([], [extra], { fired: {} }, NOW).alerts.map(a => [a.subject, a.level])).toEqual([['zai', 'cap-80']]);
  });
});

describe('wake time', () => {
  it('lands just after the earliest future reset, bounded by the interval', () => {
    const interval = 300_000;
    expect(nextWakeMs([new Date(NOW + 60_000).toISOString()], NOW, interval)).toBe(NOW + 70_000);
    expect(nextWakeMs([new Date(NOW + 3_600_000).toISOString(), null], NOW, interval)).toBe(NOW + interval);
    expect(nextWakeMs([new Date(NOW - 20_000).toISOString()], NOW, interval)).toBe(NOW + interval);
    expect(nextWakeMs([new Date(NOW - 1000).toISOString()], NOW, interval)).toBe(NOW + 9000);
  });
});

describe('live tick', () => {
  const official = { readDevin: async () => ({ status: 'unknown' as const, reason: 'missing-key' }), readClaude: () => null };
  const pages = { [claude.url]: { text: CLAUDE_TEXT }, 'https://chatgpt.com/codex/settings/usage': { url: 'https://chatgpt.com/auth/login', text: 'Log in' },
    'https://z.ai/manage-apikey/subscription': { text: 'Coding plan\nResets in 4 hr\n88% used' } };

  it('falls back to the browser, writes budgets with estimated, alerts once and lists sign-ins', async () => {
    const queueDir = tmp(), busDir = tmp();
    const browser = fakeBrowser(pages);
    const result = await runLiveUsageTick({ nowMs: NOW, queueDir, busDir, official, browser });
    expect(result.budget['claude']).toMatchObject({ weekly_used_pct: 62, source: 'browser-visible', estimated: true });
    expect(result.budget['zai']).toMatchObject({ weekly_used_pct: 88, estimated: true });
    expect(result.needsSignin[0]).toMatchObject({ site: 'chatgpt-codex' });
    const bus = readFileSync(join(busDir, 'usage-live-alerts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(bus.map(a => `${a.subject}:${a.level}`)).toEqual(expect.arrayContaining(['zai:cap-80', 'chatgpt-codex:needs-signin']));
    expect(JSON.stringify(bus)).not.toMatch(/—/);
    const snapshot = JSON.parse(readFileSync(join(queueDir, 'usage-live.json'), 'utf8'));
    expect(snapshot.schema).toBe('usage.sensors.v1');
    expect(JSON.parse(readFileSync(join(queueDir, 'usage-live-budget.json'), 'utf8')).schema).toBe('usage-live-budget.v1');

    // Same window, a minute later: no repeated alert lines.
    const before = readFileSync(join(busDir, 'usage-live-alerts.jsonl'), 'utf8');
    await runLiveUsageTick({ nowMs: NOW + 60_000, queueDir, busDir, official, browser });
    expect(readFileSync(join(busDir, 'usage-live-alerts.jsonl'), 'utf8')).toBe(before);
    expect(renderFirstReadings(result)).toContain('## Sites needing a one-time sign-in');
    expect(renderFirstReadings(result)).toContain('https://chatgpt.com/codex/settings/usage');
  });

  it('prefers an official readout and never opens that site', async () => {
    const browser = fakeBrowser(pages);
    const codexHome = tmp();
    const result = await runLiveUsageTick({ nowMs: NOW, queueDir: tmp(), busDir: tmp(), browser,
      official: { ...official, operatorHome: '/nonexistent-home', codexPersonalHome: codexHome,
        readCodex: async () => ({ pctUsed: 41, resetAt: new Date(NOW + 5 * 3_600_000).toISOString() }) } });
    expect(result.budget['codex-personal']).toMatchObject({ weekly_used_pct: 41, source: 'codex-app-server' });
    expect(browser.opened).not.toContain('https://chatgpt.com/codex/settings/usage');
  });

  it('with no browser and no readout, reports unknown rather than zero', async () => {
    const result = await runLiveUsageTick({ nowMs: NOW, queueDir: tmp(), busDir: tmp(), official, browser: null });
    expect(result.budget).toEqual({});
    expect(renderFirstReadings(result)).toContain('no source readable');
  });

  it('wakes just after the reset it reads', async () => {
    const soon = { ...pages, [claude.url]: { text: 'Current session\nResets in 20 min\n37% used' } };
    const result = await runLiveUsageTick({ nowMs: NOW, queueDir: tmp(), busDir: tmp(), official, browser: fakeBrowser(soon), intervalMs: 3_600_000 });
    expect(Date.parse(result.nextWakeAt)).toBe(NOW + 20 * 60_000 + 10_000);
    const far = await runLiveUsageTick({ nowMs: NOW, queueDir: tmp(), busDir: tmp(), official, browser: fakeBrowser(pages), intervalMs: 3_600_000 });
    expect(Date.parse(far.nextWakeAt)).toBe(NOW + 3_600_000);
  });
});

describe('phm usage live', () => {
  it('writes first readings once and refuses bad options', async () => {
    const home = tmp();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdUsageLive(['--interval', '5'], { home })).toBe(2);
      expect(await cmdUsageLive(['--headed'], { home })).toBe(2);
      expect(await cmdUsageLive(['--bus-dir', '/Users/x/.codex/bus'], { home })).toBe(2);
      const bus = join(home, 'bus'), queue = join(home, 'queue');
      expect(await cmdUsageLive(['--json', '--bus-dir', bus, '--queue-dir', queue], { home, now: () => NOW })).toBe(0);
      expect(existsSync(join(bus, 'usage-live-first-readings.md'))).toBe(true);
      const first = readFileSync(join(bus, 'usage-live-first-readings.md'), 'utf8');
      await cmdUsageLive(['--bus-dir', bus, '--queue-dir', queue], { home, now: () => NOW + 1000 });
      expect(readFileSync(join(bus, 'usage-live-first-readings.md'), 'utf8')).toBe(first);
    } finally { log.mockRestore(); err.mockRestore(); }
  });
  it('degrades to official readouts when the browser cannot launch', async () => {
    const home = tmp();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await cmdUsageLive(['--browser', '--bus-dir', join(home, 'b'), '--queue-dir', join(home, 'q')],
        { home, now: () => NOW, launch: async () => { throw new Error('no playwright'); } });
      expect(code).toBe(0);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('Official readouts only'));
    } finally { err.mockRestore(); log.mockRestore(); }
  });
});
