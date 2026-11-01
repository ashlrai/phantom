/** fleet-lane-model-set-cli.test.ts — `ashlr fleet lane-model-set` parsing,
 * exit codes, human vs --json output and the provider-id honesty line. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetLaneModelSet, formatLaneModelChange } from '../src/cli/fleet-lane-model-set.js';

let dir: string;
let modelsPath: string;
const MODELS = {
  devin: 'fake-devin-default',
  'devin.work': 'fake-devin-work',
  codex: 'fake-codex-default',
  'effort.codex.mid': 'high',
};
const seed = async () => writeFile(modelsPath, `${JSON.stringify(MODELS, null, 2)}\n`);

let out: string[];
let err: string[];
let realLog: typeof console.log;
let realOut: typeof process.stdout.write;
let realErr: typeof process.stderr.write;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lane-model-set-cli-'));
  modelsPath = join(dir, 'models.json');
  await seed();
  out = []; err = [];
  realLog = console.log; realOut = process.stdout.write; realErr = process.stderr.write;
  console.log = (msg?: unknown) => { out.push(String(msg)); };
  process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
});
afterEach(async () => {
  console.log = realLog; process.stdout.write = realOut; process.stderr.write = realErr;
  await rm(dir, { recursive: true, force: true });
});

const WARNING = 'the launcher passes this id to the provider unchanged';

it('sets a lane.tier key: prints before->after, resolved tiers, warning, written', async () => {
  expect(await cmdFleetLaneModelSet(['devin.work', 'fake-lightning-2', '--runs-dir', dir])).toBe(0);
  const text = out.join('\n');
  expect(text).toContain('devin.work: fake-devin-work -> fake-lightning-2');
  expect(text).toContain('work: fake-lightning-2 (via devin.work)');
  expect(text).toContain('frontier: fake-devin-default (via devin)');
  expect(text).toContain(WARNING);
  expect(text).toContain('models.json written');
  expect(JSON.parse(await readFile(modelsPath, 'utf8'))['devin.work']).toBe('fake-lightning-2');
});

it('unsets a key, shows the fallback tier row, and skips the provider warning', async () => {
  expect(await cmdFleetLaneModelSet(['devin.work', '--unset', '--runs-dir', dir])).toBe(0);
  const text = out.join('\n');
  expect(text).toContain('devin.work: fake-devin-work -> —');
  expect(text).toContain('work: fake-devin-default (via devin)');
  expect(text).not.toContain(WARNING);
  expect(JSON.parse(await readFile(modelsPath, 'utf8'))).not.toHaveProperty('devin.work');
});

it('dry run previews resolved tiers and writes nothing', async () => {
  const before = await readFile(modelsPath, 'utf8');
  expect(await cmdFleetLaneModelSet(['devin.work', 'fake-lightning-2', '--dry-run', '--runs-dir', dir])).toBe(0);
  const text = out.join('\n');
  expect(text).toContain('work: fake-lightning-2 (via devin.work)');
  expect(text).toContain('dry run: nothing written');
  expect(text).toContain(WARNING);
  expect(await readFile(modelsPath, 'utf8')).toBe(before);
});

it('--json prints the change record and sends the warning to stderr', async () => {
  expect(await cmdFleetLaneModelSet(['devin.work', 'fake-lightning-2', '--json', '--runs-dir', dir])).toBe(0);
  const change = JSON.parse(out[0]!);
  expect(change).toMatchObject({ v: 1, applied: true, key: 'devin.work', before: 'fake-devin-work', after: 'fake-lightning-2' });
  expect(change.resolved).toHaveLength(4);
  expect(out.join('\n')).not.toContain(WARNING);
  expect(err.join('')).toContain(WARNING);
});

it('exits 2 on usage errors', async () => {
  for (const args of [
    [] as string[],
    ['devin.work'],                                // model missing
    ['devin.work', 'a', 'b', '--runs-dir', dir],   // extra positional
    ['devin.work', 'x', '--unset', '--runs-dir', dir], // --unset with a model
    ['--unset', '--runs-dir', dir],                // --unset without a key
    ['devin.work', 'x', '--bogus'],
    ['devin.work', 'x', '--runs-dir', 'relative/path'],
    ['devin.work', 'x', '--models', 'relative/path'],
  ]) expect(await cmdFleetLaneModelSet(args), JSON.stringify(args)).toBe(2);
  expect(await readFile(modelsPath, 'utf8')).toBe(`${JSON.stringify(MODELS, null, 2)}\n`);
});

it('exits 1 with the error code on LaneModelWriteError', async () => {
  for (const [args, code] of [
    [['Devin', 'x', '--runs-dir', dir], 'key-shape'],
    [['effort.devin.work', 'x', '--runs-dir', dir], 'key-shape'],
    [['devin.work', 'swe 2', '--runs-dir', dir], 'model-shape'],
    [['devin.work', 'fake-devin-work', '--runs-dir', dir], 'no-change'],
    [['devin.mid', '--unset', '--runs-dir', dir], 'key-missing'],
    [['devin.work', 'x', '--runs-dir', join(dir, 'empty')], 'models-missing'],
  ] as const) {
    err = [];
    expect(await cmdFleetLaneModelSet([...args]), JSON.stringify(args)).toBe(1);
    expect(err.join('')).toContain(code);
  }
});

it('--help prints usage and exits 0 without writing', async () => {
  expect(await cmdFleetLaneModelSet(['--help'])).toBe(0);
  expect(err.join('') + out.join('')).toContain('lane-model-set <lane[.tier]>');
});

it('formatLaneModelChange renders null before/after as —', () => {
  const text = formatLaneModelChange({
    v: 1, generatedAt: '2026-11-01T00:00:00Z', applied: false, key: 'devin.mid',
    before: null, after: 'fake-mid',
    resolved: [
      { tier: 'frontier', model: 'fake-devin-default', via: 'devin' },
      { tier: 'work', model: 'fake-devin-default', via: 'devin' },
      { tier: 'mid', model: 'fake-mid', via: 'devin.mid' },
      { tier: 'fast', model: null, via: null },
    ],
  });
  expect(text).toContain('devin.mid: — -> fake-mid');
  expect(text).toContain('fast: —');
  expect(text).toContain('dry run: nothing written');
});
