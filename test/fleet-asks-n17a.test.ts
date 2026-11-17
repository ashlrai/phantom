import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetAsks } from '../src/cli/fleet-asks.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { MASON_ASKS, type MasonAsk } from '../src/core/fleet/mason-asks.js';
import {
  checkMasonAsks,
  exportNames,
  readSourceIndex,
  renderMasonAsksMarkdown,
  renderMasonAsksText,
  type SourceIndex,
} from '../src/core/fleet/mason-asks-check.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURE_ASKS: MasonAsk[] = [
  { id: 'X1', title: 'All there', ask: 'fake', pieces: [
    { need: 'pane one', path: 'src/fake/one.pane.tsx' },
    { need: 'view one', path: 'src/fake/One.tsx', exportName: 'OneView' },
  ] },
  { id: 'X2', title: 'Half there', ask: 'fake', pieces: [
    { need: 'view two', path: 'src/fake/Two.tsx', exportName: 'TwoView' },
    { need: 'a fake gap' },
  ] },
  { id: 'X3', title: 'Not there', ask: 'fake', pieces: [
    { need: 'view three', path: 'src/fake/Three.tsx' },
  ] },
  { id: 'X4', title: 'Nothing to check', ask: 'fake', pieces: [] },
];

const FIXTURE_INDEX: SourceIndex = {
  paths: ['src/fake/one.pane.tsx', 'src/fake/One.tsx', 'src/fake/Two.tsx'],
  exports: { 'src/fake/one.pane.tsx': [], 'src/fake/One.tsx': ['OneView'], 'src/fake/Two.tsx': ['TwoView'] },
};

describe('checkMasonAsks', () => {
  it('judges done, partial, missing and unknown from a path list', () => {
    const { asks } = checkMasonAsks(FIXTURE_ASKS, FIXTURE_INDEX);
    expect(asks.map(ask => [ask.id, ask.state])).toEqual([['X1', 'done'], ['X2', 'partial'], ['X3', 'missing'], ['X4', 'unknown']]);
    expect(asks[0]).toMatchObject({ evidence: ['src/fake/one.pane.tsx', 'src/fake/One.tsx'], gaps: [], next: 'None; check it by hand in the app.' });
    expect(asks[1]).toMatchObject({ evidence: ['src/fake/Two.tsx'], gaps: ['a fake gap'], next: 'Build a fake gap.' });
    expect(asks[2]).toMatchObject({ evidence: [], gaps: ['view three'], next: 'Restore view three (src/fake/Three.tsx).' });
  });

  it('does not count a file that lacks its named export', () => {
    const index: SourceIndex = { ...FIXTURE_INDEX, exports: { ...FIXTURE_INDEX.exports, 'src/fake/One.tsx': ['SomethingElse'] } };
    const x1 = checkMasonAsks(FIXTURE_ASKS, index).asks[0]!;
    expect(x1.state).toBe('partial');
    expect(x1.gaps).toEqual(['view one']);
  });

  it('reads every ask as unknown without a source index', () => {
    const { asks } = checkMasonAsks(FIXTURE_ASKS, null);
    expect(asks.every(ask => ask.state === 'unknown' && ask.evidence.length === 0)).toBe(true);
    expect(asks[0]!.next).toBe('Run from a source checkout so the code can be read.');
  });

  it('keeps the real ask list to nine asks A1-A9, each with something to check', () => {
    expect(MASON_ASKS.map(ask => ask.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9']);
    for (const ask of MASON_ASKS) expect(ask.pieces.length, ask.id).toBeGreaterThan(0);
  });
});

describe('exportNames', () => {
  it('finds declared and listed exports', () => {
    const source = [
      'export function A() {}',
      'export async function B() {}',
      'export const C = 1;',
      'export class D {}',
      'export interface E {}',
      'export type F = string;',
      'export { G, H as I, type J };',
      'const notExported = 1;',
      '  export const indented = 2;',
    ].join('\n');
    expect(exportNames(source).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'I', 'J']);
  });
});

describe('readSourceIndex', () => {
  let root: string | undefined;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  it('returns null outside a source checkout', () => {
    root = mkdtempSync(join(tmpdir(), 'asks-n17a-'));
    expect(readSourceIndex(root, FIXTURE_ASKS)).toBeNull();
  });

  it('lists present files and their exports', () => {
    root = mkdtempSync(join(tmpdir(), 'asks-n17a-'));
    mkdirSync(join(root, 'src/web-ui/routes/verse'), { recursive: true });
    mkdirSync(join(root, 'src/fake'), { recursive: true });
    writeFileSync(join(root, 'src/fake/one.pane.tsx'), 'registerPane({});\n');
    writeFileSync(join(root, 'src/fake/One.tsx'), 'export function OneView() {}\n');
    const index = readSourceIndex(root, FIXTURE_ASKS)!;
    expect(index.paths).toEqual(['src/fake/one.pane.tsx', 'src/fake/One.tsx']);
    expect(index.exports['src/fake/One.tsx']).toEqual(['OneView']);
    expect(checkMasonAsks(FIXTURE_ASKS, index).asks.map(ask => ask.state)).toEqual(['done', 'missing', 'missing', 'unknown']);
  });
});

describe('renderers', () => {
  const report = checkMasonAsks(FIXTURE_ASKS, FIXTURE_INDEX);

  it('prints one plain line per ask', () => {
    expect(renderMasonAsksText(report).trimEnd().split('\n')).toEqual([
      'X1 done    All there: None; check it by hand in the app.',
      'X2 partial Half there: Build a fake gap.',
      'X3 missing Not there: Restore view three (src/fake/Three.tsx).',
      'X4 unknown Nothing to check: Run from a source checkout so the code can be read.',
    ]);
  });

  it('renders the markdown table with counts and evidence', () => {
    const markdown = renderMasonAsksMarkdown(report, FIXTURE_ASKS);
    expect(markdown).toContain('Summary: 1 done, 1 partial, 1 missing, 1 unknown.');
    expect(markdown).toContain('| X2 | Half there | partial | Build a fake gap. |');
    expect(markdown).toContain('- `src/fake/One.tsx`');
  });
});

describe('phm fleet asks status', () => {
  async function run(args: string[]) {
    let out = '', err = '';
    const code = await cmdFleetAsks(args, { output: text => { out += text; }, error: text => { err += text; } });
    return { code, out, err };
  }

  it('is registered as a convention fleet verb', () => {
    expect(typeof FLEET_SUBCOMMAND_LOADERS['asks']).toBe('function');
  });

  it('prints nine plain lines for this checkout', async () => {
    const { code, out } = await run(['status', '--root', REPO_ROOT]);
    expect(code).toBe(0);
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(9);
    for (const [i, line] of lines.entries()) expect(line).toMatch(new RegExp(`^A${i + 1} (done|partial|missing|unknown) +\\S`));
  });

  it('prints fleet.asks.v1 JSON with id, title, state, evidence and next', async () => {
    const { code, out } = await run(['status', '--json', '--root', REPO_ROOT]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as { schema: string; asks: Array<Record<string, unknown>> };
    expect(report.schema).toBe('fleet.asks.v1');
    expect(report.asks).toHaveLength(9);
    for (const ask of report.asks) expect(Object.keys(ask)).toEqual(['id', 'title', 'state', 'evidence', 'gaps', 'next']);
  });

  it('shows unknown, not missing, when the root is not a source checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'asks-n17a-'));
    try {
      const { code, out } = await run(['status', '--json', '--root', root]);
      expect(code).toBe(0);
      const states = (JSON.parse(out) as { asks: Array<{ state: string }> }).asks.map(ask => ask.state);
      expect(new Set(states)).toEqual(new Set(['unknown']));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps docs/MASON-ASKS-STATUS.md in step with the command', async () => {
    const { out } = await run(['status', '--markdown', '--root', REPO_ROOT]);
    expect(readFileSync(join(REPO_ROOT, 'docs/MASON-ASKS-STATUS.md'), 'utf8')).toBe(out);
  });

  it('prints help and refuses bad arguments', async () => {
    expect((await run(['--help'])).code).toBe(0);
    expect((await run([])).code).toBe(2);
    expect((await run(['status', '--json', '--markdown'])).code).toBe(2);
    expect((await run(['status', '--wat'])).code).toBe(2);
    expect((await run(['status', '--root'])).code).toBe(2);
  });
});
