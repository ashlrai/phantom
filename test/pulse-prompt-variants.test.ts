/**
 * RQ-SELFOPT-PROMPT-OPT: the `phm pulse` "Prompt variants" dashboard section —
 * promoted variants render their before/after merge-rate numbers, and the
 * registry rides along as an additive --json field.
 *
 * All data sources are mocked (same stance as test/m15.pulse-json.test.ts):
 * the promotions fixture is the committed benchmark record, console.log is
 * spied on because renderDashboard writes through console, not stdout.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import type { PromptPromotionsRegistry } from '../src/core/eval/prompt-promotions.js';

const COMMITTED_PROMOTIONS = JSON.parse(
  readFileSync(join(fileURLToPath(new URL('../benchmarks/prompt-ab/', import.meta.url)), 'promotions.json'), 'utf8'),
) as PromptPromotionsRegistry;

vi.mock('../src/core/observability/rollup.js', () => ({
  buildRollup: vi.fn(() => ({
    window: '7d', since: '2026-10-28T00:00:00.000Z',
    totals: { tokensIn: 0, tokensOut: 0, estCostUsd: 0, sessions: 0, commits: 0 },
    byProject: [], byModel: [], byDay: [],
    budget: { level: 'ok', window: '7d', message: '', spentUsd: 0, capUsd: null, spentTokens: 0, capTokens: null },
  })),
}));
vi.mock('../src/core/observability/forecast.js', () => ({ buildForecast: vi.fn(() => null) }));
vi.mock('../src/core/observability/governance.js', () => ({ evalGovernance: vi.fn(() => null) }));
vi.mock('../src/core/config.js', () => ({ loadConfig: vi.fn(() => ({})) }));
vi.mock('../src/core/eval/prompt-promotions.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/eval/prompt-promotions.js')>();
  return { ...mod, loadPromptPromotions: vi.fn(() => COMMITTED_PROMOTIONS) };
});

import { cmdPulse } from '../src/cli/pulse.js';

function captureConsole(): { restore: () => void; text: () => string } {
  const chunks: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  });
  return { restore: () => spy.mockRestore(), text: () => chunks.join('\n') };
}

describe('phm pulse prompt-variant section', () => {
  it('shows the promoted variant with before/after numbers', async () => {
    const cap = captureConsole();
    try {
      expect(await cmdPulse([])).toBe(0);
    } finally {
      cap.restore();
    }
    const text = cap.text();
    expect(text).toContain('Prompt variants');
    expect(text).toContain('prompt:adaptive');
    expect(text).toContain('33.3%');
    expect(text).toContain('77.8%');
    expect(text).toContain('+44.4 pts');
  });

  it('carries the registry as an additive --json field', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
    try {
      expect(await cmdPulse(['--json'])).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    const parsed = JSON.parse(chunks.join(''));
    expect(parsed.promptVariants.promoted[0].variant).toBe('prompt:adaptive');
    expect(parsed.promptVariants.promoted[0].before.value).toBeCloseTo(1 / 3, 4);
    expect(parsed.promptVariants.promoted[0].after.value).toBeCloseTo(21 / 27, 4);
  });
});
