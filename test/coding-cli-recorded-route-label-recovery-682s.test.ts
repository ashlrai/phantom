import { describe, expect, it } from 'vitest';
import {
  RECORDED_ROUTE_LABELS,
  RECORDED_ROUTE_PROVENANCE,
  inspectRecordedRouteLabels,
} from '../src/core/providers/coding-cli/recorded-route-label.js';

// Source routeOf outcomes from PR #5952 (3d6c8fb7): a route label, 'ambiguous', or null (missing).
const sourceExamples: ReadonlyArray<readonly [readonly string[], string | 'ambiguous' | null]> = [
  [['route:codex'], 'route:codex'], [['route:claude'], 'route:claude'], [['route:grok'], 'route:grok'],
  [['route:any'], 'route:any'], [[], null], [['bug', 'help wanted'], null],
  [['Route:Codex'], null], [['ROUTE:CLAUDE'], null], [[' route:codex'], null], [['route:codex '], null],
  [['bug', 'route:claude', 'help wanted'], 'route:claude'],
  [['route:codex', 'route:claude'], 'ambiguous'], [['route:any', 'route:grok'], 'ambiguous'],
  [['route:codex', 'route:codex'], 'ambiguous'], [['route:any', 'route:any'], 'ambiguous'],
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('inspectRecordedRouteLabels (recovered from #5952 routeOf)', () => {
  it('exports the source label set and provenance', () => {
    expect([...RECORDED_ROUTE_LABELS]).toEqual(['route:codex', 'route:claude', 'route:grok', 'route:any']);
    expect(RECORDED_ROUTE_PROVENANCE).toMatchObject({
      pr: 5952, sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886', authority: 'historical-offline',
    });
  });

  it('maps each pinned label to its historical backend string', () => {
    expect(inspectRecordedRouteLabels(['route:codex'])).toMatchObject({
      status: 'pinned', route: 'route:codex', backend: 'codex', matches: ['route:codex'], seatRouterChoiceRequired: false,
    });
    expect(inspectRecordedRouteLabels(['route:claude'])).toMatchObject({ status: 'pinned', backend: 'claude' });
    expect(inspectRecordedRouteLabels(['route:grok'])).toMatchObject({ status: 'pinned', backend: 'grok' });
  });

  it('reports route:any as unresolved and never invents a backend', () => {
    expect(inspectRecordedRouteLabels(['route:any'])).toMatchObject({
      status: 'any', route: 'route:any', backend: null, seatRouterChoiceRequired: true,
      reason: 'route:any waits for the seat-router policy pass',
    });
  });

  it('reports missing for no labels, unrelated labels, and near-miss spellings', () => {
    expect(inspectRecordedRouteLabels([])).toMatchObject({ status: 'missing', route: null, backend: null, matches: [] });
    expect(inspectRecordedRouteLabels(['bug', 'help wanted'])).toMatchObject({ status: 'missing', backend: null });
    for (const label of ['Route:Codex', 'ROUTE:CLAUDE', ' route:codex', 'route:codex ', 'route/codex', 'route:gpt']) {
      expect(inspectRecordedRouteLabels([label]).status, label).toBe('missing');
    }
  });

  it('ignores unrelated labels around one pinned route', () => {
    expect(inspectRecordedRouteLabels(['bug', 'route:claude', 'help wanted'])).toMatchObject({
      status: 'pinned', route: 'route:claude', backend: 'claude', matches: ['route:claude'],
    });
  });

  it('reports mixed routes and duplicate identical routes as ambiguous', () => {
    expect(inspectRecordedRouteLabels(['route:codex', 'route:claude'])).toMatchObject({
      status: 'ambiguous', route: null, backend: null, matches: ['route:codex', 'route:claude'],
      reason: 'more than one route label',
    });
    expect(inspectRecordedRouteLabels(['route:any', 'route:grok']).status).toBe('ambiguous');
    expect(inspectRecordedRouteLabels(['route:codex', 'route:codex'])).toMatchObject({
      status: 'ambiguous', matches: ['route:codex', 'route:codex'],
    });
    expect(inspectRecordedRouteLabels(['route:any', 'route:any']).status).toBe('ambiguous');
  });

  it('agrees with every source routeOf example', () => {
    for (const [labels, expected] of sourceExamples) {
      const result = inspectRecordedRouteLabels(labels);
      if (expected === null) expect(result.status, JSON.stringify(labels)).toBe('missing');
      else if (expected === 'ambiguous') expect(result.status, JSON.stringify(labels)).toBe('ambiguous');
      else expect(result.route, JSON.stringify(labels)).toBe(expected);
    }
  });

  it('grants no execution authority on any result', () => {
    for (const labels of [[], ['route:codex'], ['route:any'], ['route:codex', 'route:claude']]) {
      expect(inspectRecordedRouteLabels(labels)).toMatchObject({ provenance: 'historical-offline', executionAuthority: 'none' });
    }
  });

  it('never mutates its input, including frozen input', () => {
    const frozen = deepFreeze(['bug', 'route:codex', 'route:codex']);
    const before = JSON.stringify(frozen);
    expect(() => inspectRecordedRouteLabels(frozen)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it('rejects malformed runtime input instead of fabricating a route', () => {
    for (const bad of [undefined, null, 'route:codex', { 0: 'route:codex', length: 1 }]) {
      expect(() => inspectRecordedRouteLabels(bad as unknown as string[])).toThrow(TypeError);
    }
    for (const entry of [42, null, undefined, { label: 'route:codex' }]) {
      expect(() => inspectRecordedRouteLabels(['bug', entry] as unknown as string[])).toThrow(
        'recorded route labels: labels[1] must be a string',
      );
    }
    // A sparse hole reads as undefined and must throw, not count as "missing".
    const sparse = new Array<string>(2);
    sparse[0] = 'route:codex';
    expect(() => inspectRecordedRouteLabels(sparse)).toThrow(TypeError);
  });
});
