import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserSession } from '../src/core/usage/live/browser.js';
import { runLiveUsageTick } from '../src/core/usage/live/engine.js';
import { USAGE_SITES } from '../src/core/usage/live/sites.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const zai = USAGE_SITES.find(s => s.id === 'zai')!;
const gemini = USAGE_SITES.find(s => s.id === 'gemini')!;
const SITES = [zai, gemini];
const official = { readDevin: async () => ({ status: 'unknown' as const, reason: 'missing-key' }), readClaude: () => null };
const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'usage-reset-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeBrowser(pages: Record<string, { url?: string; text?: string; fail?: boolean }>): BrowserSession {
  return {
    async newPage() {
      let current = '';
      return {
        async goto(url: string) { current = url; if (pages[url]?.fail) throw new Error('boom'); },
        url: () => pages[current]?.url ?? current,
        visibleText: async () => pages[current]?.text ?? '',
        close: async () => {},
      };
    },
    close: async () => {},
  };
}

const zaiText = (pct: number, reset: string) => `Coding plan\n${reset}\n${pct}% used`;
const geminiText = (pct: number, reset: string) => `Usage\n${reset}\n${pct}% used`;
const iso = (ms: number) => new Date(ms).toISOString();

function seedSnapshot(queueDir: string, extras: unknown[]): void {
  writeFileSync(join(queueDir, 'usage-live.json'),
    `${JSON.stringify({ schema: 'usage.sensors.v1', generatedAt: iso(NOW), readings: [], extras })}\n`);
}
const savedExtras = (queueDir: string): unknown[] =>
  (JSON.parse(readFileSync(join(queueDir, 'usage-live.json'), 'utf8')) as { extras?: unknown[] }).extras ?? [];
const savedBudget = (queueDir: string): Record<string, Record<string, unknown>> =>
  (JSON.parse(readFileSync(join(queueDir, 'usage-live-budget.json'), 'utf8')) as { lanes: Record<string, Record<string, unknown>> }).lanes;
const extra = (over: Record<string, unknown> = {}) => ({
  site: 'zai', budgetLane: 'zai', used: 42, limit: 100, unit: 'percent',
  resetAt: iso(NOW + 3_600_000), observedAt: iso(NOW - 5 * 60_000), ...over,
});

describe('usage live reset truth', () => {
  it('omits a fresh persisted extra once its known reset passes, even with no browser', async () => {
    const queueDir = tmp(), busDir = tmp();
    const browser = fakeBrowser({
      [zai.url]: { text: zaiText(42, 'Resets in 10 min') },
      [gemini.url]: { text: geminiText(55, 'Resets in 3 days') },
    });
    const first = await runLiveUsageTick({ nowMs: NOW, queueDir, busDir, official, browser, sites: SITES });
    expect(first.budget['zai']).toMatchObject({ weekly_used_pct: 42 });
    expect(first.budget['gemini']).toMatchObject({ weekly_used_pct: 55 });

    // 10 min later zai's window has reset; gemini's has not. No browser this pass.
    const second = await runLiveUsageTick({ nowMs: NOW + 10 * 60_000 + 1, queueDir, busDir, official, browser: null, sites: SITES });
    expect(second.budget['zai']).toBeUndefined();
    expect(second.budget['gemini']).toMatchObject({ weekly_used_pct: 55, reset_at: expect.any(String) });
    expect(second.extras.map(e => e.site)).toEqual(['gemini']);
    expect(savedBudget(queueDir)['zai']).toBeUndefined();
    expect(savedBudget(queueDir)['gemini']).toMatchObject({ weekly_used_pct: 55 });
    expect(savedExtras(queueDir)).toHaveLength(1);
    // No synthetic zero and no stale percent anywhere.
    expect(JSON.stringify(second.budget)).not.toContain('"weekly_used_pct":0');
    expect(second.alerts.filter(a => a.subject === 'zai')).toEqual([]);
  });

  it('a fresh reading for one site cannot resurrect an expired sibling', async () => {
    const queueDir = tmp(), busDir = tmp();
    const browser = fakeBrowser({
      [zai.url]: { text: zaiText(42, 'Resets in 10 min') },
      [gemini.url]: { text: geminiText(55, 'Resets in 10 min') },
    });
    await runLiveUsageTick({ nowMs: NOW, queueDir, busDir, official, browser, sites: SITES });

    // After both resets: zai reads fresh, gemini's page is unreadable so only
    // its persisted extra could supply a number — and that window has ended.
    const pages = {
      [zai.url]: { text: zaiText(10, 'Resets in 2 days') },
      [gemini.url]: { text: 'Nothing readable here' },
    };
    const second = await runLiveUsageTick({ nowMs: NOW + 10 * 60_000 + 1, queueDir, busDir,
      official, browser: fakeBrowser(pages), sites: SITES });
    expect(second.budget['zai']).toMatchObject({ weekly_used_pct: 10 });
    expect(second.budget['gemini']).toBeUndefined();
    expect(second.extras.map(e => e.site)).toEqual(['zai']);
    expect(savedExtras(queueDir)).toHaveLength(1);
    const busFile = join(busDir, 'usage-live-alerts.jsonl');
    const bus = existsSync(busFile) ? readFileSync(busFile, 'utf8') : '';
    expect(bus).not.toContain('gemini');
  });

  it('keeps a valid unexpired persisted extra across a failed browser pass', async () => {
    const queueDir = tmp(), busDir = tmp();
    seedSnapshot(queueDir, [extra({ used: 67, resetAt: iso(NOW + 3_600_000), observedAt: iso(NOW - 2 * 60_000) })]);
    const result = await runLiveUsageTick({ nowMs: NOW, queueDir, busDir, official, browser: null, sites: SITES });
    expect(result.budget['zai']).toMatchObject({ weekly_used_pct: 67, estimated: true });
    expect(savedExtras(queueDir)).toHaveLength(1);
  });

  it('rejects stale, expired and malformed persisted extras', async () => {
    const cases: Array<[string, unknown, boolean]> = [
      ['stale observation', extra({ observedAt: iso(NOW - 16 * 60_000) }), false],
      ['future observation', extra({ observedAt: iso(NOW + 60_000) }), false],
      ['non-ISO observation', extra({ observedAt: 'yesterday' }), false],
      ['reset already passed', extra({ resetAt: iso(NOW - 1) }), false],
      ['reset exactly now', extra({ resetAt: iso(NOW) }), false],
      ['string used', extra({ used: '42' }), false],
      ['negative used', extra({ used: -1 }), false],
      ['zero limit', extra({ limit: 0 }), false],
      ['negative limit', extra({ limit: -100 }), false],
      ['percent over 100', extra({ used: 140 }), false],
      ['percent wrong limit', extra({ limit: 50 }), false],
      ['unknown unit', extra({ unit: 'widgets' }), false],
      ['lane-bound site', extra({ site: 'claude', budgetLane: 'claude' }), false],
      ['budget lane mismatch', extra({ budgetLane: 'other' }), false],
      ['not an object', 'junk', false],
      ['null row', null, false],
      ['missing reset stays usable', extra({ resetAt: null }), true],
      ['garbage reset stays unknown', extra({ resetAt: 'soonish' }), true],
      ['fresh unexpired', extra(), true],
    ];
    for (const [name, row, kept] of cases) {
      const queueDir = tmp(), busDir = tmp();
      seedSnapshot(queueDir, [row]);
      const result = await runLiveUsageTick({ nowMs: NOW, queueDir, busDir, official, browser: null, sites: SITES });
      if (kept) {
        expect(result.budget['zai'], name).toMatchObject({ weekly_used_pct: 42 });
        expect(savedExtras(queueDir), name).toHaveLength(1);
      } else {
        expect(result.budget, name).toEqual({});
        expect(savedExtras(queueDir), name).toEqual([]);
      }
    }
    // Invalid reset evidence is kept as unknown, never fabricated.
    const queueDir = tmp(), busDir = tmp();
    seedSnapshot(queueDir, [extra({ resetAt: 'soonish' })]);
    const result = await runLiveUsageTick({ nowMs: NOW, queueDir, busDir, official, browser: null, sites: SITES });
    expect(result.budget['zai']).toMatchObject({ weekly_used_pct: 42, reset_at: null });
  });

  it('an expired extra at the cap raises no alert and writes no stale budget', async () => {
    const queueDir = tmp(), busDir = tmp();
    seedSnapshot(queueDir, [extra({ used: 97, resetAt: iso(NOW - 60_000), observedAt: iso(NOW - 5 * 60_000) })]);
    const result = await runLiveUsageTick({ nowMs: NOW, queueDir, busDir, official, browser: null, sites: SITES });
    expect(result.budget).toEqual({});
    expect(result.alerts).toEqual([]);
    expect(savedExtras(queueDir)).toEqual([]);
    const busFile = join(busDir, 'usage-live-alerts.jsonl');
    expect(existsSync(busFile) ? readFileSync(busFile, 'utf8') : '').not.toContain('zai');
  });
});
