import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlToVisibleText } from '../src/core/usage/browser/visible-text.js';
import { parseResetAt, parseUsagePage, type BrowserProvider } from '../src/core/usage/browser/parsers.js';
import { defaultProfileDir, readAllBrowserUsage, readBrowserUsage, writeBusRecords } from '../src/core/usage/browser/reader.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const fixture = (name: string) => readFile(join(__dirname, 'fixtures', 'usage-browser', `${name}.html`), 'utf8');
const text = async (name: string) => htmlToVisibleText(await fixture(name));
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe('htmlToVisibleText', () => {
  it('drops scripts, styles, head, hidden subtrees (nested) and decodes entities', () => {
    const t = htmlToVisibleText(
      '<head><title>x</title></head><div>A &amp; B&nbsp;&#33;</div><script>if(a<b){}</script><div aria-hidden="true"><div>no</div>still no</div><p style="display: none">gone</p><p>Last</p><!-- c -->',
    );
    expect(t).toBe('A & B !\nLast');
  });
  it('keeps inline elements on one line and splits blocks', () => {
    expect(htmlToVisibleText('<p><b>62%</b> remaining</p><p>Next</p>')).toBe('62% remaining\nNext');
  });
});

describe('parseResetAt', () => {
  it.each([
    ['2 hr 14 min', iso(134 * 60_000)],
    ['in 3 days', iso(3 * 86_400_000)],
    ['45m', iso(45 * 60_000)],
    ['2026-11-14T00:00:00Z', '2026-11-14T00:00:00.000Z'],
  ])('parses %s', (raw, want) => expect(parseResetAt(raw, NOW.getTime())).toBe(want));
  it.each(['Fri 9:00 AM', 'Dec 1', '9:00 AM', 'soon', '', '0 min', '2 hr foo'])('refuses %j rather than guessing', (raw) =>
    expect(parseResetAt(raw, NOW.getTime())).toBeNull());
});

describe('per-provider page parsers on rendered fixtures', () => {
  const base = { estimated: false, observed_at: NOW.toISOString() };
  it.each<[BrowserProvider, object]>([
    ['claude', { used: 37, limit: 100, unit: 'percent', reset_at: iso(134 * 60_000), source: 'browser:claude' }],
    ['chatgpt', { used: 38, limit: 100, unit: 'percent', reset_at: iso(185 * 60_000), source: 'browser:chatgpt' }],
    ['devin', { used: 123.5, limit: 500, unit: 'acu', reset_at: iso(12 * 86_400_000), source: 'browser:devin' }],
    ['zai', { used: 30, limit: 100, unit: 'percent', reset_at: iso(90 * 60_000), source: 'browser:zai' }],
    ['gemini', { used: 12, limit: 100, unit: 'points', reset_at: iso(6 * 3_600_000), source: 'browser:gemini' }],
  ])('%s reports the binding window', async (provider, want) => {
    const r = parseUsagePage(provider, await text(provider), NOW);
    expect(r).toEqual({ ok: true, record: { ...base, ...want } });
  });

  it('ignores hidden and script text when picking the binding window', async () => {
    const r = parseUsagePage('claude', await text('claude'), NOW);
    expect(r.ok && r.record.used).toBe(37); // hidden 99% never wins
  });

  it('claude reset_at is null when only a wall-clock reset is shown', () => {
    const r = parseUsagePage('claude', 'All models\nResets Fri 9:00 AM\n12% used', NOW);
    expect(r).toMatchObject({ ok: true, record: { used: 12, reset_at: null } });
  });

  it('refuses a login wall and an unrecognised page, never reporting 0', async () => {
    for (const p of ['claude', 'chatgpt', 'devin', 'zai', 'gemini'] as const) {
      expect(parseUsagePage(p, await text('login'), NOW)).toEqual({ ok: false, reason: 'login-required' });
      expect(parseUsagePage(p, 'Hello world', NOW)).toEqual({ ok: false, reason: 'no-match' });
    }
  });

  it.each([
    ['percent over 100', 'claude', 'Current session\n140% used'],
    ['count used above limit', 'gemini', 'Daily limit\n120 of 100 requests'],
    ['devin count without ACU', 'devin', 'Usage this month\n3 / 5 seats'],
    ['bare percent, ambiguous direction', 'zai', '5 hours usage\n30%'],
  ] as const)('refuses %s', (_n, provider, body) => {
    expect(parseUsagePage(provider, body, NOW).ok).toBe(false);
  });
});

describe('readBrowserUsage / bus', () => {
  it('passes the persistent profile to the driver and records only successes', async () => {
    const calls: Array<{ provider: string; url: string; profileDir: string }> = [];
    const results = await readAllBrowserUsage({
      homeDir: '/h',
      now: () => NOW,
      fetchVisibleText: async (req) => {
        calls.push(req);
        if (req.provider === 'zai') throw new Error('boom');
        return req.provider === 'gemini' ? text('login') : text(req.provider);
      },
    });
    expect(calls.every((c) => c.profileDir === '/h/.ashlr-runs/usage-browser')).toBe(true);
    expect(calls.map((c) => c.provider)).toEqual(['claude', 'chatgpt', 'devin', 'zai', 'gemini']);
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['ok', 'ok', 'ok', 'fetch-failed', 'login-required']);

    const dir = await mkdtemp(join(tmpdir(), 'usage-bus-'));
    const written = await writeBusRecords(results, dir);
    expect((await readdir(dir)).sort()).toEqual(['usage-browser-chatgpt.json', 'usage-browser-claude.json', 'usage-browser-devin.json']);
    expect(written).toHaveLength(3);
    const rec = JSON.parse(await readFile(join(dir, 'usage-browser-devin.json'), 'utf8'));
    expect(Object.keys(rec).sort()).toEqual(['estimated', 'limit', 'observed_at', 'reset_at', 'source', 'unit', 'used']);
  });

  it('honours url overrides and the default profile path', async () => {
    let seen = '';
    await readBrowserUsage('devin', { urls: { devin: 'https://example.test/b' }, fetchVisibleText: async (r) => ((seen = r.url), '') });
    expect(seen).toBe('https://example.test/b');
    expect(defaultProfileDir('/x')).toBe('/x/.ashlr-runs/usage-browser');
  });
});
