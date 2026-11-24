/**
 * Regression for RQ-PHX-ASKSOWNERRECOVER611S — the Mason-asks CLI recovered
 * from PR #6538 (source commit 208b587471a, PR head 882b3a89f1c) onto master.
 *
 * The original n17a suite (test/fleet-asks-n17a.test.ts) covers the checker
 * units; this file pins the recovery contracts themselves:
 *   - the verb reaches cmdFleetAsks through the real convention chain
 *     (resolveFleetSubcommand + FLEET_SUBCOMMAND_LOADERS), never a hand edit
 *     to fleet.ts/index.ts/help.ts/completions.ts;
 *   - PR #6547's follow-up scripts can still find their byte-exact rows in
 *     src/core/fleet/mason-asks.ts;
 *   - a synthetic checkout drives every state, and a done state means source
 *     presence only — never installed, released or runtime-verified.
 * All fixtures are synthetic files under a temporary directory; nothing here
 * dispatches live or reaches a network.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetAsks } from '../src/cli/fleet-asks.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { MASON_ASKS } from '../src/core/fleet/mason-asks.js';
import { checkMasonAsks, readSourceIndex, type MasonAskStatus } from '../src/core/fleet/mason-asks-check.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SENTINEL = 'src/web-ui/routes/verse';
/** A9 Live usage: the smallest ask whose every piece can be staged in a fixture. */
const A9_STAGED: ReadonlyArray<readonly [path: string, exportName: string, body: string]> = [
  [`${SENTINEL}/resources/ResourcesDrawer.tsx`, 'ResourcesDrawer', 'export function ResourcesDrawer() { return null; }\n'],
  [`${SENTINEL}/resources/ResetsTimeline.tsx`, 'ResetsTimeline', 'export const ResetsTimeline = () => null;\n'],
  [`${SENTINEL}/resources/missing-reading-reason.ts`, 'missingReadingReason', 'export function missingReadingReason() { return "unknown"; }\n'],
  ['src/cli/usage-resource-live.ts', 'cmdUsageResourceLive', 'export async function cmdUsageResourceLive(): Promise<number> { return 0; }\n'],
];

let roots: string[] = [];

function makeCheckout(withSentinel: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'asks-611s-'));
  roots.push(root);
  if (withSentinel) mkdirSync(join(root, SENTINEL), { recursive: true });
  return root;
}

function stage(root: string, staged: ReadonlyArray<readonly [string, string, string]>): void {
  for (const [path, , body] of staged) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
}

/** Directory listing plus content digests — proves a run left the checkout untouched. */
function snapshot(root: string): string {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [`${relative(root, full)} ${statSync(full).size} ${createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16)}`];
    });
  return walk(root).sort();
}

/** The exact dispatch chain `phm fleet asks ...` runs — no shortcuts. */
async function dispatched(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const resolved = resolveFleetSubcommand('asks');
  expect(resolved).toEqual({ module: './fleet-asks.js', exportName: 'cmdFleetAsks' });
  const loader = FLEET_SUBCOMMAND_LOADERS['asks'];
  expect(typeof loader).toBe('function');
  const loaded = (await loader!()) as Record<string, unknown>;
  expect(loaded['cmdFleetAsks'], 'registry loader must surface the convention export name').toBe(cmdFleetAsks);
  let out = '', err = '';
  const code = await cmdFleetAsks(args, { output: text => { out += text; }, error: text => { err += text; } });
  return { code, out, err };
}

function parseReport(out: string): { schema: string; asks: MasonAskStatus[] } {
  return JSON.parse(out) as { schema: string; asks: MasonAskStatus[] };
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('recovery contracts (PR #6538 source commit 208b587471a)', () => {
  it('includes the recovered report in the generated docs index', () => {
    const result = spawnSync(process.execPath, ['scripts/generate-docs-llms.mjs', '--check'], {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(REPO_ROOT, 'docs/llms.txt'), 'utf8')).toContain('MASON-ASKS-STATUS');
  });

  it('keeps the public exports PR #6547 composes on', () => {
    expect(typeof checkMasonAsks).toBe('function');
    expect(typeof readSourceIndex).toBe('function');
    expect(typeof MASON_ASKS).toBe('object');
    expect(MASON_ASKS.map(ask => ask.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9']);
    expect(checkMasonAsks(MASON_ASKS, null).schema).toBe('fleet.asks.v1');
  });

  it('keeps the byte-exact rows the #6547 follow-up scripts patch', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/core/fleet/mason-asks.ts'), 'utf8');
    for (const marker of ["    id: 'A3',", "    id: 'A4',"]) expect(source, marker).toContain(marker);
    for (const row of [
      "      { need: 'a graph of high-leverage PRs merged over time' },",
      "      { need: 'a graph of autonomy over time' },",
      "      { need: 'a Library screen in the phone view' },",
    ]) expect(source.split(row), `exactly one: ${row}`).toHaveLength(2);
  });

  it('registers asks only through the generated convention, with no dispatcher edits', () => {
    const registry = readFileSync(join(REPO_ROOT, 'src/cli/fleet-subcommand-registry.ts'), 'utf8');
    expect(registry).toContain("'asks': () => import('./fleet-asks.js'),");
    expect(registry.split('\n')[0]).toContain('generated by scripts/gen-fleet-registry.mjs');
    // The top-level `phm asks` needs-you ledger (src/cli/asks.ts, asks.v1)
    // predates this recovery; the fleet-level verb shadows nothing. The
    // convention ships with zero edits to the dispatcher files: `asks` reaches
    // cmdFleetAsks through resolveFleetSubcommand + this registry alone.
    expect(readFileSync(join(REPO_ROOT, 'src/cli/fleet.ts'), 'utf8')).not.toMatch(/\basks\b/u);
    for (const untouched of ['src/cli/index.ts', 'src/cli/help.ts', 'src/cli/completions.ts']) {
      expect(readFileSync(join(REPO_ROOT, untouched), 'utf8')).not.toMatch(/fleet-asks|cmdFleetAsks/u);
    }
  });
});

describe('convention-dispatched CLI', () => {
  it('answers status --json with the schema and all nine asks from this checkout', async () => {
    const { code, out, err } = await dispatched(['status', '--json']);
    expect(code).toBe(0);
    expect(err).toBe('');
    const report = parseReport(out);
    expect(report.schema).toBe('fleet.asks.v1');
    expect(report.asks).toHaveLength(9);
    const states = new Set(['done', 'partial', 'missing', 'unknown']);
    for (const [i, ask] of report.asks.entries()) {
      expect(ask.id).toBe(`A${i + 1}`);
      expect(Object.keys(ask)).toEqual(['id', 'title', 'state', 'evidence', 'gaps', 'next']);
      expect(states.has(ask.state), ask.state).toBe(true);
      expect(ask.next).not.toBe('');
    }
  });

  it('fails conflicting format flags and malformed arguments with exit 2', async () => {
    for (const bad of [['status', '--json', '--markdown'], ['status', '--markdown', '--json'], ['status', '--wat'], ['status', '--root'], ['status', '--root', '--json'], ['bogus'], []]) {
      const { code, err } = await dispatched(bad);
      expect(code, bad.join(' ')).toBe(2);
      expect(err).toContain('Usage: phm fleet asks status');
    }
    expect((await dispatched(['--help'])).code).toBe(0);
  });

  it('leaves the checkout it judged byte-for-byte unchanged', async () => {
    const root = makeCheckout(true);
    stage(root, A9_STAGED);
    const before = snapshot(root);
    const { code } = await dispatched(['status', '--json', '--root', root]);
    expect(code).toBe(0);
    expect(snapshot(root)).toEqual(before);
    const asksBefore = JSON.stringify(MASON_ASKS);
    checkMasonAsks(MASON_ASKS, readSourceIndex(root, MASON_ASKS));
    expect(JSON.stringify(MASON_ASKS)).toBe(asksBefore);
  });
});

describe('source presence versus runtime qualification', () => {
  it('reads done from staged source alone and says so in the next step', async () => {
    const root = makeCheckout(true);
    stage(root, A9_STAGED);
    const { code, out } = await dispatched(['status', '--json', '--root', root]);
    expect(code).toBe(0);
    const report = parseReport(out);
    const a9 = report.asks[8]!;
    expect(a9.state).toBe('done');
    expect(a9.evidence).toEqual(A9_STAGED.map(([path]) => path));
    expect(a9.gaps).toEqual([]);
    expect(a9.next).toBe('None; check it by hand in the app.');
    for (const ask of report.asks.slice(0, 8)) expect(ask.state).toBe('missing');
    expect(out.toLowerCase()).not.toMatch(/releas|shipped|install|runtime-verified/u);
  });

  it('counts a staged file without its export as a gap, not evidence', async () => {
    const root = makeCheckout(true);
    stage(root, A9_STAGED.slice(1));
    writeFileSync(join(root, A9_STAGED[0]![0]), 'function ResourcesDrawer() { return null; }\n');
    const { code, out } = await dispatched(['status', '--json', '--root', root]);
    expect(code).toBe(0);
    const a9 = parseReport(out).asks[8]!;
    expect(a9.state).toBe('partial');
    expect(a9.evidence).toEqual(A9_STAGED.slice(1).map(([path]) => path));
    expect(a9.gaps).toEqual(['the Resources view']);
    // A gap with a path reads as a restore (the file exists but lacks its
    // export); only path-less pieces read as "Build".
    expect(a9.next).toBe(`Restore the Resources view (${A9_STAGED[0]![0]}).`);
  });

  it('reads unknown, never missing, where no source checkout exists', async () => {
    const root = makeCheckout(false);
    const { code, out } = await dispatched(['status', '--json', '--root', root]);
    expect(code).toBe(0);
    const report = parseReport(out);
    expect(report.asks.map(ask => ask.state)).toEqual(Array.from({ length: 9 }, () => 'unknown'));
    expect(report.asks.every(ask => ask.evidence.length === 0 && ask.gaps.length === 0)).toBe(true);
    const { out: markdown } = await dispatched(['status', '--markdown', '--root', root]);
    expect(markdown).toContain('Summary: 0 done, 0 partial, 0 missing, 9 unknown.');
    expect(markdown).toContain('judged from the code on master.');
    expect(markdown).toContain('Do not edit by hand; rerun the command.');
  });
});
