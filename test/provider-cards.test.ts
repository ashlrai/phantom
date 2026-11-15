import { describe, expect, it } from 'vitest';
import { buildProviderCards, formatProviderCards, providerOfName } from '../src/core/fabric/provider-cards.js';
import { buildResourceView } from '../src/core/fabric/resource-view.js';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const iso = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

describe('provider cards', () => {
  it('groups pools by vendor and keeps unread pools unknown', () => {
    const view = buildResourceView({ readings: {
      'claude-max': { pool: 'claude-max', pctUsed: 40, resetAt: iso(3), fetchedAt: iso(0), source: 'claude-max-reader', burnRatePctPerHour: 30 },
      'codex-cmp': { pool: 'codex-cmp', pctUsed: 10, resetAt: iso(5), fetchedAt: iso(0), source: 'codex-cmp-reader', burnRatePctPerHour: 1 },
    } }, NOW);
    const cards = buildProviderCards(view);
    expect(cards.providers.map(c => c.provider)).toEqual(['openai', 'anthropic', 'cognition', 'xai']);
    const by = Object.fromEntries(cards.providers.map(c => [c.provider, c]));
    expect(by.openai!.pools.map(p => p.pool)).toEqual(['codex-cmp', 'codex-personal', 'terra']);
    expect(by.openai).toMatchObject({ status: 'green', maxPctUsed: 10, nextResetAt: iso(5) });
    expect(by.anthropic).toMatchObject({ status: 'amber', maxPctUsed: 40 });
    expect(by.xai).toMatchObject({ status: 'unknown', maxPctUsed: null, nextResetAt: null });
    expect(by.cognition!.pools[0]!.pctUsed).toBeNull();
  });
  it('prints unknown rather than an invented percentage and never carries secrets', () => {
    const text = formatProviderCards(buildProviderCards(buildResourceView({}, NOW)));
    expect(text).toContain('xAI: unknown, highest used unknown, next reset unknown');
    expect(text).toContain('Local models: unknown');
    expect(text).not.toMatch(/\d%/);
  });
  it('maps free-form worker providers without guessing', () => {
    expect(providerOfName('codex')).toBe('openai');
    expect(providerOfName('Claude Code')).toBe('anthropic');
    expect(providerOfName('mystery')).toBeNull();
  });
});
