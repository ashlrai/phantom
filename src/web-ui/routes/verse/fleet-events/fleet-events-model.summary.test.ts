import { describe, expect, it } from 'vitest';
import { summarizeKinds } from './fleet-events-model.js';

describe('summarizeKinds', () => {
  it('returns empty string for an empty list', () => {
    expect(summarizeKinds([])).toBe('');
  });

  it('counts per kind, orders by count desc then name asc, and pluralises with simple s', () => {
    const items = [
      { id: 'a', at: '2026-01-01T00:00:00Z', kind: 'launch', text: '', url: null },
      { id: 'b', at: '2026-01-01T00:01:00Z', kind: 'launch', text: '', url: null },
      { id: 'c', at: '2026-01-01T00:02:00Z', kind: 'launch', text: '', url: null },
      { id: 'd', at: '2026-01-01T00:03:00Z', kind: 'publish', text: '', url: null },
      { id: 'e', at: '2026-01-01T00:04:00Z', kind: 'publish', text: '', url: null },
      { id: 'f', at: '2026-01-01T00:05:00Z', kind: 'incident', text: '', url: null },
    ];
    expect(summarizeKinds(items)).toBe('3 launchs · 2 publishs · 1 incidents');
  });

  it('sorts equal-count kinds alphabetically', () => {
    const items = [
      { id: 'a', at: '2026-01-01T00:00:00Z', kind: 'tick', text: '', url: null },
      { id: 'b', at: '2026-01-01T00:00:00Z', kind: 'launch', text: '', url: null },
      { id: 'c', at: '2026-01-01T00:00:00Z', kind: 'hold', text: '', url: null },
    ];
    expect(summarizeKinds(items)).toBe('1 holds · 1 launchs · 1 ticks');
  });

  it('does not double-pluralise kinds already ending in s', () => {
    const items = [
      { id: 'a', at: '2026-01-01T00:00:00Z', kind: 'publishes', text: '', url: null },
      { id: 'b', at: '2026-01-01T00:00:00Z', kind: 'publishes', text: '', url: null },
      { id: 'c', at: '2026-01-01T00:00:00Z', kind: 'publishes', text: '', url: null },
    ];
    expect(summarizeKinds(items)).toBe('3 publishes');
  });
});
