import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRAND_IDS, BRANDS, brandBadge, brandOf, monogramOf, resolveBrand, terminalColor,
} from '../src/core/brand/registry.js';
import { PROVIDER_POOLS, PROVIDERS } from '../src/core/fabric/provider-cards.js';
import { formatAgentRoster } from '../src/core/fleet/agent-roster.js';

describe('brand registry completeness', () => {
  it('every id has a drawable mark, label, glyph and hex', () => {
    expect(Object.keys(BRANDS).sort()).toEqual([...BRAND_IDS].sort());
    for (const id of BRAND_IDS) {
      const spec = BRANDS[id];
      expect(spec.id).toBe(id);
      expect(spec.layers.length).toBeGreaterThan(0);
      expect(spec.layers.every(l => /^M/.test(l.d))).toBe(true);
      expect(spec.viewBox).toMatch(/^0 0 \d+ \d+$/);
      expect(spec.label).not.toBe('');
      expect([...spec.glyph]).toHaveLength(1);
      expect(spec.hex).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('covers the required companies by id, product name and vendor name', () => {
    const cases: Array<[string, string]> = [
      ['codex', 'codex'], ['OpenAI', 'codex'], ['claude', 'claude'], ['Anthropic', 'claude'],
      ['grok', 'grok'], ['xAI', 'grok'], ['devin', 'devin'], ['Cognition', 'devin'],
      ['gemini', 'gemini'], ['Google', 'gemini'], ['cursor', 'cursor'], ['ollama', 'local'], ['local', 'local'],
    ];
    for (const [name, id] of cases) expect(resolveBrand(name), name).toBe(id);
  });

  it('resolves every lane, pool and provider id the fleet uses', () => {
    for (const lane of ['codex-cmp', 'codex-personal', 'codex-local', 'claude', 'claude-api', 'claude-max', 'devin-flash', 'grok-ultra', 'terra']) {
      expect(resolveBrand(lane), lane).not.toBeNull();
    }
    for (const provider of PROVIDERS) expect(resolveBrand(provider), provider).not.toBeNull();
    for (const pool of Object.values(PROVIDER_POOLS).flat()) expect(resolveBrand(pool), pool).not.toBeNull();
  });

  it('every alias round-trips to its own brand', () => {
    for (const id of BRAND_IDS) for (const alias of BRANDS[id].aliases) expect(resolveBrand(alias), alias).toBe(id);
  });
});

describe('brand registry fallback', () => {
  it('returns null (never a wrong logo) for unknown names', () => {
    for (const name of ['zai', 'agy', 'mistral', '', '  ', null, undefined]) expect(resolveBrand(name), String(name)).toBeNull();
    expect(brandOf('zai')).toBeNull();
  });

  it('builds a tasteful, never-empty monogram', () => {
    expect(monogramOf('zai')).toBe('Z');
    expect(monogramOf('agy-lane')).toBe('AL');
    expect(monogramOf('mistral large')).toBe('ML');
    expect(monogramOf('')).toBe('?');
    expect(monogramOf(null)).toBe('?');
    expect(monogramOf('---')).toBe('?');
  });
});

describe('CLI badges', () => {
  it('stay empty without colour so piped output is unchanged', () => {
    expect(brandBadge('claude', false)).toBe('');
    expect(brandBadge('zai', false)).toBe('');
  });

  it('tint the brand glyph, and dim-monogram unknown names', () => {
    expect(brandBadge('claude', true)).toBe('\x1b[38;2;217;119;87m✻\x1b[0m ');
    expect(brandBadge('zai', true)).toBe('\x1b[2mZ\x1b[0m ');
  });

  it('terminalColor honours TTY, NO_COLOR and dumb terminals', () => {
    expect(terminalColor({ isTTY: true }, {})).toBe(true);
    expect(terminalColor({ isTTY: false }, {})).toBe(false);
    expect(terminalColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(terminalColor({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
  });

  it('roster table adds the badge only when asked', () => {
    const roster = {
      schema: 'agent-roster.v1', observedAt: '2026-11-16T00:00:00Z', latencyMs: 1, sources: [],
      claims: { source: 'bus', items: [] },
      sessions: [{ provider: 'claude', sessionId: 's1', title: null, state: 'live', ownership: null, claims: [], lastActivity: null, blockers: [] }],
    } as unknown as Parameters<typeof formatAgentRoster>[0];
    expect(formatAgentRoster(roster)).toContain('\nclaude  s1');
    expect(formatAgentRoster(roster, { color: true })).toContain('✻\x1b[0m claude  s1');
  });
});

describe('docs assets stay in step with the registry', () => {
  const pathsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/\sd="([^"]+)"/g)].map(m => m[1]);
  const cases: Array<[string, (typeof BRAND_IDS)[number]]> = [
    ['provider-claude', 'claude'], ['provider-codex', 'codex'], ['provider-grok', 'grok'],
    ['provider-local', 'local'], ['provider-gemini', 'gemini'], ['provider-cursor', 'cursor'], ['devin-mark', 'devin'],
  ];
  for (const [file, id] of cases) {
    it(`site/assets/${file}.svg matches the ${id} mark`, () => {
      const drawn = pathsOf(`site/assets/${file}.svg`).join('|');
      const expected = BRANDS[id].layers.map(l => l.d).join('|');
      if (id === 'devin') expect(drawn).toContain(expected.slice(0, 80)); // vendor favicon keeps its own path syntax
      else expect(drawn).toBe(expected);
    });
  }
});
