import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mirrorPathFor, runInAutonomousLane } from '../src/core/fleet/mirrors.js';
import { buildGraph, impact } from '../src/core/knowledge/graph.js';
import { enroll, runWithEnrollmentLens } from '../src/core/sandbox/policy.js';

let work: string;
let mirror: string | undefined;

function repo(relative: string): string {
  const dir = path.join(work, relative);
  fs.mkdirSync(dir, { recursive: true });
  expect(enroll(dir).ok).toBe(true);
  return fs.realpathSync(dir);
}

function plant(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

beforeEach(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'impact-31u-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(work, { recursive: true, force: true });
  if (mirror) fs.rmSync(mirror, { recursive: true, force: true });
  mirror = undefined;
});

describe('bounded, deterministic knowledge impact', () => {
  it('deduplicates canonical roots, stops at 500 during collection, and keeps cross-repo order', () => {
    const alpha = repo('alpha');
    const beta = repo('beta');
    const later = repo('zeta');
    const alias = path.join(work, 'alpha-alias');
    fs.symlinkSync(alpha, alias, 'dir');
    const first = plant(alpha, 'src/a.ts', "import 'shared/needle';\n".repeat(280));
    plant(beta, 'src/b.ts', "import 'shared/needle';\n".repeat(250));
    plant(later, 'src/c.ts', "import 'shared/needle';\n");
    const reads = vi.spyOn(fs, 'readFileSync');
    const walks = vi.spyOn(fs, 'readdirSync');
    const roots = [later, alias, beta, alpha, alias];

    const result = impact('shared/needle.ts', roots);
    expect(result.references).toHaveLength(500);
    expect(new Set(result.references.map((ref) => JSON.stringify(ref))).size).toBe(500);
    expect(result.references[0]).toEqual({ repo: 'alpha', file: 'src/a.ts', line: 1 });
    expect(result.references[279]).toEqual({ repo: 'alpha', file: 'src/a.ts', line: 280 });
    expect(result.references[280]).toEqual({ repo: 'beta', file: 'src/b.ts', line: 1 });
    expect(result.references[499]).toEqual({ repo: 'beta', file: 'src/b.ts', line: 220 });
    expect(result.dependents).toEqual(['alpha/src/a', 'beta/src/b']);
    expect(reads.mock.calls.filter(([file]) => file === first)).toHaveLength(1);
    expect(walks.mock.calls.filter(([dir]) => dir === alpha)).toHaveLength(1);
    expect(walks.mock.calls.filter(([dir]) => dir === later)).toHaveLength(0);
    expect(impact('shared/needle.ts', [alpha, beta, later, alias])).toEqual(result);
  });

  it('scans repeated imports and canonical aliases once for graph construction', () => {
    const alpha = repo('alpha');
    const beta = repo('beta');
    const alias = path.join(work, 'alias');
    fs.symlinkSync(alpha, alias, 'dir');
    const first = plant(alpha, 'src/use.ts', "import 'shared-lib/sub';\n".repeat(1000));
    plant(beta, 'src/use.ts', "import 'shared-lib/sub';\n");
    const reads = vi.spyOn(fs, 'readFileSync');
    const graph = buildGraph([beta, alias, alpha, alias]);

    expect(reads.mock.calls.filter(([file]) => file === first)).toHaveLength(1);
    expect(graph.edges.filter((edge) => edge.from === 'module:alpha/src/use.ts' && edge.to === 'dep:shared-lib')).toHaveLength(1);
    expect(graph.crossRepo.find((item) => item.kind === 'shared-dep')?.detail)
      .toBe('shared-lib shared across 2 repos: alpha@*, beta@*');
    expect(buildGraph([alpha, beta])).toEqual(graph);
  });

  it('deduplicates indistinguishable references without letting them consume the cap', () => {
    const first = repo('one/shared');
    const second = repo('two/shared');
    plant(first, 'src/a.ts', "import 'needle';\n".repeat(300));
    plant(second, 'src/a.ts', "import 'needle';\n".repeat(300));
    plant(second, 'src/z.ts', "import 'needle';\n".repeat(250));
    const result = impact('needle', [second, first]);
    expect(result.references).toHaveLength(500);
    expect(new Set(result.references.map((ref) => JSON.stringify(ref))).size).toBe(500);
    expect(result.references[300]).toEqual({ repo: 'shared', file: 'src/z.ts', line: 1 });
    expect(result.references[499]).toEqual({ repo: 'shared', file: 'src/z.ts', line: 200 });
  });

  it('excludes an absolute target named through a root alias', () => {
    const alpha = repo('alpha');
    const alias = path.join(work, 'alias');
    fs.symlinkSync(alpha, alias, 'dir');
    plant(alpha, 'src/needle.ts', '// needle.ts\n');
    plant(alpha, 'src/use.ts', "import './needle';\n");
    expect(impact(path.join(alias, 'src/needle.ts'), [alpha, alias]).references)
      .toEqual([{ repo: 'alpha', file: 'src/use.ts', line: 1 }]);
  });

  it('continues to scrub secret-shaped graph details', () => {
    const alpha = repo('alpha');
    const beta = repo('beta');
    const secretShape = 'a'.repeat(40);
    for (const root of [alpha, beta]) {
      plant(root, 'package.json', JSON.stringify({ dependencies: { shared: secretShape } }));
    }
    const detail = buildGraph([alpha, beta]).crossRepo.find((item) => item.kind === 'shared-dep')?.detail;
    expect(detail).toContain('[REDACTED]');
    expect(detail).not.toContain(secretShape);
  });

  it('respects enrollment lenses, skips symlink escapes, and remains local-only', () => {
    const alpha = repo('alpha');
    const beta = repo('beta');
    const outside = path.join(work, 'outside');
    fs.mkdirSync(outside);
    plant(alpha, 'src/inside.ts', "import 'needle';\n");
    plant(beta, 'src/inside.ts', "import 'needle';\n");
    const external = plant(outside, 'escape.ts', "import 'needle';\n");
    fs.symlinkSync(external, path.join(alpha, 'linked.ts'));
    fs.symlinkSync(outside, path.join(alpha, 'linked-dir'), 'dir');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const result = runWithEnrollmentLens(
      { label: 'alpha only', admits: (candidate) => candidate === alpha },
      () => impact('needle', [beta, outside, alpha]),
    );
    expect(result.references).toEqual([{ repo: 'alpha', file: 'src/inside.ts', line: 1 }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('filters default fleet mirrors while preserving the autonomous lens and explicit roots', () => {
    const checkout = repo('checkout');
    plant(checkout, 'src/use.ts', "import 'needle';\n");
    mirror = mirrorPathFor(`fixture-${path.basename(work)}/widget`);
    fs.mkdirSync(mirror, { recursive: true });
    mirror = fs.realpathSync(mirror);
    plant(mirror, 'src/use.ts', "import 'needle';\n");
    expect(enroll(mirror).ok).toBe(true);
    expect(impact('needle').references.map((ref) => ref.repo)).toEqual(['checkout']);
    expect(impact('needle', [mirror]).references.map((ref) => ref.repo)).toEqual([path.basename(mirror)]);
    expect(runInAutonomousLane(() => impact('needle')).references.map((ref) => ref.repo))
      .toEqual([path.basename(mirror)]);
  });
});
