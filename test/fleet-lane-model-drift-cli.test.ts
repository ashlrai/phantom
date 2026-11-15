/** fleet-lane-model-drift-cli.test.ts — `phm fleet lane-model-drift` against a
 * real temp runs dir reached through ASHLR_RUNS_DIR: exit 1 on an unknown
 * lane model, the --json v1 shape, --all output, and exit 2 on a bad flag.
 * Known/historical fixture ids come from KNOWN_MODELS itself so the test
 * cannot go stale when the catalog changes. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetLaneModelDrift, formatLaneModelDrift } from '../src/cli/fleet-lane-model-drift.js';
import { KNOWN_MODELS } from '../src/core/run/model-catalog.js';

const tagOf = (id: string) => id.slice(id.indexOf(':') + 1);
const KNOWN_TAG = tagOf(KNOWN_MODELS.find(m => !m.historical)!.id);
const HISTORICAL_TAG = tagOf(KNOWN_MODELS.find(m => m.historical)!.id);
const UNKNOWN_MODEL = 'fake-notamodel-9'; // plainly fake — no catalog entry spells it
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lane-model-drift-cli-'));
  await mkdir(join(dir, 'metrics'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const seed = async (models: Record<string, string>, jobs: string[] = []) => {
  await writeFile(join(dir, 'models.json'), JSON.stringify(models));
  await writeFile(join(dir, 'metrics', 'jobs.jsonl'), jobs.map(j => `${j}\n`).join(''));
};
const launch = (lane: string, model: string, tier?: string) =>
  JSON.stringify({ event: 'launch', job: `RQ-${lane}-1`, lane, model, ...(tier ? { tier } : {}), ts: '2026-11-04T10:00:00Z' });

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const logs: string[] = [];
  const [log, err] = [console.log, process.stderr.write];
  console.log = (msg?: unknown) => { logs.push(String(msg)); };
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return { code: await cmdFleetLaneModelDrift(args), out: logs.join('\n') };
  } finally { console.log = log; process.stderr.write = err; }
}

it('exits 1 and prints the unknown row when a lane names a model the catalog does not know', async () => {
  await seed({
    'codex-personal': KNOWN_TAG, // every tier except fast resolves here → deduped to one known row
    'codex-personal.fast': UNKNOWN_MODEL,
  }, [launch('codex-personal', KNOWN_TAG, 'fast')]);
  const plain = await run([]);
  expect(plain.code).toBe(1);
  expect(plain.out).toContain(`codex-personal.fast  ${UNKNOWN_MODEL}  unknown  via codex-personal.fast`);
  expect(plain.out).not.toContain(KNOWN_TAG); // known rows stay hidden without --all
  expect(plain.out).toContain('1 unknown');
  const all = await run(['--all']);
  expect(all.out).toMatch(new RegExp(`${esc(KNOWN_TAG)}\\s+known\\s+via codex-personal$`, 'm'));
});

it('exits 0 when only known and historical models resolve, printing the historical row', async () => {
  await seed({ claude: KNOWN_TAG, 'claude.work': HISTORICAL_TAG });
  const { code, out } = await run([]);
  expect(code).toBe(0); // historical alone is a warning, not a failure
  expect(out).toContain(`${HISTORICAL_TAG}  historical`);
  expect(out).toContain('0 unknown');
});

it('emits the fleet.lane-model-drift.v1 object under --json', async () => {
  await seed({ 'codex-personal.fast': UNKNOWN_MODEL, 'claude.work': HISTORICAL_TAG });
  const { code, out } = await run(['--json']);
  expect(code).toBe(1);
  const report = JSON.parse(out);
  expect(report.schema).toBe('fleet.lane-model-drift.v1');
  expect(report.counts).toEqual({ known: 0, historical: 1, unknown: 1 });
  expect(report.rows).toEqual([
    { lane: 'claude', tier: 'work', model: HISTORICAL_TAG, via: 'claude.work', status: 'historical' },
    { lane: 'codex-personal', tier: 'fast', model: UNKNOWN_MODEL, via: 'codex-personal.fast', status: 'unknown' },
  ]);
  expect(report.sources.models.state).toBe('healthy');
  expect(report.sources.launches.state).toBe('healthy');
});

it('exits 0 with an empty report when the runs dir has no models', async () => {
  const { code, out } = await run(['--json']);
  expect(code).toBe(0);
  const report = JSON.parse(out);
  expect(report.rows).toEqual([]);
  expect(report.counts).toEqual({ known: 0, historical: 0, unknown: 0 });
  expect(report.sources.models.state).toBe('missing');
});

it('refuses unknown flags and relative paths with exit 2', async () => {
  expect((await run(['--bogus'])).code).toBe(2);
  expect((await run(['--runs-dir', 'relative/path'])).code).toBe(2);
  expect((await run(['--runs-dir'])).code).toBe(2);
});

it('formats known rows only under --all and always appends the total', () => {
  const report = {
    schema: 'fleet.lane-model-drift.v1' as const, generatedAt: '2026-11-04T20:00:00Z',
    rows: [
      { lane: 'claude', tier: 'work', model: 'fake-a', via: 'claude.work', status: 'known' as const },
      { lane: 'codex', tier: 'fast', model: 'fake-b', via: 'codex.fast', status: 'unknown' as const },
    ],
    counts: { known: 1, historical: 0, unknown: 1 },
    sources: {
      models: { state: 'healthy' as const, file: 'models.json' as const, entries: 2 },
      launches: { state: 'missing' as const, file: 'metrics/jobs.jsonl' as const, launches: 0, dropped: 0 },
    },
  };
  const plain = formatLaneModelDrift(report);
  expect(plain).toMatch(/codex\.fast\s+fake-b\s+unknown\s+via codex\.fast/);
  expect(plain).not.toContain('fake-a');
  expect(plain).toContain('total: 2 resolved — 1 known, 0 historical, 1 unknown');
  expect(plain).toContain('sources: models.json healthy (2 entries) · jobs.jsonl missing');
  expect(formatLaneModelDrift(report, true)).toMatch(/claude\.work\s+fake-a\s+known\s+via claude\.work/);
});
