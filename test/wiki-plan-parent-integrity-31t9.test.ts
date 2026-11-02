import { describe, expect, it } from 'vitest';

import type { RepoFacts } from '../src/core/knowledge/wiki/facts.js';
import { inputHash, planPages, specHash } from '../src/core/knowledge/wiki/plan.js';
import { EMPTY_STEERING, type WikiCustomPage, type WikiSteering } from '../src/core/knowledge/wiki/steering.js';
import type { WikiPageSpec } from '../src/core/knowledge/wiki/types.js';

const facts: RepoFacts = {
  name: 'fixture', head: null, fileCount: 2, truncated: false, description: null,
  readme: { title: 'Fixture', summary: '', cite: { file: 'README.md', line: 1 } },
  languages: [], manifests: ['package.json'], scripts: [], bins: [], makeTargets: [],
  entrypoints: [{ file: 'src/main.ts', why: 'entry', cite: { file: 'src/main.ts', line: 1 } }],
  modules: [], dataStores: [], routes: [], envVars: [],
  tests: { files: 0, dirs: [], runner: null }, lineIndex: { 'src/main.ts': 1 }, texts: new Map(),
};

function page(title: string, parent?: string): WikiCustomPage {
  return { title, purpose: `About ${title}`, notes: [`Note ${title}`], ...(parent ? { parent } : {}) };
}

function steering(pages: WikiCustomPage[], options: Partial<WikiSteering> = {}): WikiSteering {
  return { ...EMPTY_STEERING, devinDefinesPages: true, pages, ...options };
}

function hierarchy(specs: WikiPageSpec[]): Array<[string, string | undefined]> {
  return specs.map(({ id, parent }) => [id, parent]);
}

function expectValidHierarchy(specs: WikiPageSpec[]): void {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  expect(byId.size).toBe(specs.length);
  for (const spec of specs) {
    const visited = new Set<string>();
    let current: WikiPageSpec | undefined = spec;
    while (current) {
      expect(visited.has(current.id)).toBe(false);
      visited.add(current.id);
      if (!current.parent) break;
      expect(byId.has(current.parent)).toBe(true);
      current = byId.get(current.parent);
    }
  }
}

describe('wiki plan parent integrity', () => {
  it('removes a parent omitted only by the final page limit', () => {
    const pages = [page('Child', 'Parent'), page('Parent')];
    const full = planPages(facts, steering(pages));
    const limited = planPages(facts, steering(pages, { maxPages: 2 }));
    expect(hierarchy(full)).toEqual([['overview', undefined], ['custom-child', 'custom-parent'], ['custom-parent', undefined]]);
    expect(hierarchy(limited)).toEqual([['overview', undefined], ['custom-child', undefined]]);
    expectValidHierarchy(limited);

    const original = full[1]!;
    const kept = limited[1]!;
    const { parent: _parent, ...withoutParent } = original;
    expect(kept).toEqual(withoutParent);
    const hashContext = { blobs: new Map([['src/main.ts', 'blob']]), tree: 'tree', steering: 'steering' };
    expect(specHash(kept, ['repo note'])).toBe(specHash(original, ['repo note']));
    expect(inputHash({ ...kept, specHash: specHash(kept, []) }, hashContext))
      .toBe(inputHash({ ...original, specHash: specHash(original, []) }, hashContext));
  });

  it('breaks a two-page cycle once, preserving incoming links', () => {
    const specs = planPages(facts, steering([page('Lead', 'Alpha'), page('Alpha', 'Beta'), page('Beta', 'Alpha')]));
    expect(hierarchy(specs)).toEqual([
      ['overview', undefined], ['custom-lead', 'custom-alpha'], ['custom-alpha', 'custom-beta'], ['custom-beta', undefined],
    ]);
    expectValidHierarchy(specs);
  });

  it('breaks a three-page cycle deterministically', () => {
    const specs = planPages(facts, steering([page('Alpha', 'Beta'), page('Beta', 'Gamma'), page('Gamma', 'Alpha')]));
    expect(hierarchy(specs)).toEqual([
      ['overview', undefined], ['custom-alpha', 'custom-beta'], ['custom-beta', 'custom-gamma'], ['custom-gamma', undefined],
    ]);
    expectValidHierarchy(specs);
  });

  it('preserves an ordinary forward reference and selection order', () => {
    const specs = planPages(facts, steering([page('Child', 'PARENT'), page('Parent', 'Overview')], { include: ['overview'] }));
    expect(hierarchy(specs)).toEqual([
      ['overview', undefined], ['custom-child', 'custom-parent'], ['custom-parent', 'overview'],
    ]);
    expectValidHierarchy(specs);
  });

  it('clears links to excluded parents without removing the child', () => {
    const specs = planPages(facts, steering([page('Child', 'Parent'), page('Parent')], { exclude: ['custom-parent'] }));
    expect(hierarchy(specs)).toEqual([['overview', undefined], ['custom-child', undefined]]);
    expectValidHierarchy(specs);
  });

  it('retains duplicate-title ID and last-title resolution behavior', () => {
    const pages = [page('Child', 'Topic'), page('Topic'), page('topic', 'Overview')];
    const specs = planPages(facts, steering(pages));
    expect(hierarchy(specs)).toEqual([
      ['overview', undefined], ['custom-child', 'custom-topic-2'], ['custom-topic', undefined], ['custom-topic-2', 'overview'],
    ]);
    expectValidHierarchy(specs);
    const limited = planPages(facts, steering(pages, { maxPages: 3 }));
    expect(hierarchy(limited)).toEqual([['overview', undefined], ['custom-child', undefined], ['custom-topic', undefined]]);
    expectValidHierarchy(limited);
  });

  it('is stable across calls and does not mutate steering', () => {
    const options = steering([page('Alpha', 'Beta'), page('Beta', 'Alpha'), page('Child', 'Alpha')], { exclude: ['overview'] });
    const before = structuredClone(options);
    const first = planPages(facts, options);
    const second = planPages(facts, options);
    expect(first).toEqual(second);
    expect(options).toEqual(before);
    expectValidHierarchy(first);
  });
});
