import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diffModelcaps, parseModelcaps, renderModelcapsReport } from '../src/core/radar/modelcaps.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(
  new URL(`./fixtures/radar-modelcaps/${name}.json`, import.meta.url), 'utf8',
));
const before = fixture('before');
const after = fixture('after');

afterEach(() => vi.unstubAllGlobals());

describe('RADAR-MODELCAPS offline inventories', () => {
  it('parses saved list responses without contacting a provider', () => {
    const fetch = vi.fn(() => { throw new Error('Network forbidden'); });
    vi.stubGlobal('fetch', fetch);
    expect(parseModelcaps(before)).toEqual([
      { id: 'fixture-coder-v1', capabilities: ['completion', 'tools'] },
      { id: 'fixture-general' },
      { id: 'fixture-retired', capabilities: [] },
    ]);
    renderModelcapsReport(diffModelcaps(before, after));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports the exact new model', () => {
    expect(diffModelcaps(before, after).added).toEqual([
      { id: 'fixture-new', capabilities: ['completion'] },
    ]);
  });

  it('reports the exact removed model', () => {
    expect(diffModelcaps(before, after).removed).toEqual([
      { id: 'fixture-retired', capabilities: [] },
    ]);
  });

  it('renders a deterministic report including advertised capability changes', () => {
    expect(renderModelcapsReport(diffModelcaps(before, after))).toBe([
      'RADAR-MODELCAPS',
      'New models (1): [{"id":"fixture-new","capabilities":["completion"]}]',
      'Removed models (1): [{"id":"fixture-retired","capabilities":[]}]',
      'Capability changes (1): [{"id":"fixture-coder-v1","before":["completion","tools"],"after":["completion","tools","vision"]}]',
      'Inventory observations only; availability and capability claims are not verified.',
    ].join('\n'));
  });

  it('ignores list ordering, repeated capability tags and unrelated metadata', () => {
    const a = { data: [{ id: 'b', capabilities: ['tools', 'completion', 'tools'] }, { id: 'a' }] };
    const b = { data: [{ id: 'a', owned_by: 'other' }, { id: 'b', capabilities: ['completion', 'tools'] }] };
    expect(diffModelcaps(a, b)).toEqual({ added: [], removed: [], changed: [] });
  });

  it('distinguishes unknown capabilities from an explicit empty list', () => {
    expect(diffModelcaps({ data: [{ id: 'a' }] }, { data: [{ id: 'a', capabilities: [] }] }).changed)
      .toEqual([{ id: 'a', before: null, after: [] }]);
  });

  it('accepts a genuinely empty inventory and reports all removals', () => {
    expect(parseModelcaps({ data: [] })).toEqual([]);
    expect(diffModelcaps(before, { data: [] }).removed).toHaveLength(3);
    expect(diffModelcaps({ data: [] }, after).added).toHaveLength(3);
  });

  it.each([
    null, [], {}, { error: { message: 'unauthorized' } }, { data: null },
    { data: [null] }, { data: [42] }, { data: [{}] }, { data: [{ id: '' }] },
    { data: [{ id: ' padded ' }] }, { data: [{ id: 'bad\nname' }] },
    { data: [{ id: 'a' }, { id: 'a' }] },
    { data: [{ id: 'a', capabilities: 'tools' }] },
    { data: [{ id: 'a', capabilities: [null] }] },
    { data: [{ id: 'a', capabilities: [''] }] },
    { data: [], has_more: true }, { data: [], has_more: 'false' },
  ])('rejects invalid or partial response %# before calculating a diff', invalid => {
    expect(() => parseModelcaps(invalid)).toThrow();
    expect(() => diffModelcaps(before, invalid)).toThrow();
    expect(() => diffModelcaps(invalid, after)).toThrow();
  });

  it('keeps model identities case sensitive and does not mutate input', () => {
    const body = { data: [{ id: 'B', capabilities: ['vision', 'tools'] }, { id: 'b' }] };
    const original = JSON.stringify(body);
    expect(parseModelcaps(body).map(model => model.id)).toEqual(['B', 'b']);
    expect(JSON.stringify(body)).toBe(original);
  });
});
