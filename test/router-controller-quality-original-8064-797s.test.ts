import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetRouterWeights } from '../src/cli/fleet-router-weights.js';

let root: string;
let runs: string;
let output: string[];
const now = (): string => '2026-11-22T00:00:00.000Z';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quality-original-797s-'));
  runs = join(root, 'runs');
  mkdirSync(join(runs, 'metrics'), { recursive: true });
  mkdirSync(join(runs, 'queue'), { recursive: true });
  mkdirSync(join(root, 'ashlr'), { recursive: true });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  output = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(' ')); });
  writeFileSync(join(runs, 'metrics', 'jobs.jsonl'), Array.from({ length: 20 }, (_, i) =>
    JSON.stringify({ job: `fake-job-${i}`, lane: 'fake-lane', work_class: 'code', phase: 'MERGED' })).join('\n') + '\n');
  writeFileSync(join(runs, 'queue', 'weights.json'), '{"fake-lane":0.5}\n');
  writeFileSync(join(root, 'ashlr', 'config.toml'), '# fake config\n');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function files(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(files(path)) : [[path, readFileSync(path, 'utf8')]];
  }));
}

async function run(json: boolean): Promise<string> {
  output = [];
  expect(await cmdFleetRouterWeights(['--runs-dir', runs, ...(json ? ['--json'] : [])], undefined, now)).toBe(0);
  return output.join('\n');
}

function state(score: number, to: number): void {
  writeFileSync(join(runs, 'queue', 'fleet-controller.json'), JSON.stringify({ quality_receipts: [{
    schema: 'route.quality.v1', lane: 'fake-lane', ts: 100, score, from: 1, to,
    resolved: 31, reason: 'quality_adjustment', mode: 'enforce',
  }] }));
}

it('keeps recorded controller verdicts advisory while reporting changed evidence', async () => {
  state(0.2, 0.3);
  const before = files(root);
  const first = JSON.parse(await run(true));
  const firstText = await run(false);
  expect(files(root)).toEqual(before);
  state(0.9, 0.9);
  const changed = files(root);
  const second = JSON.parse(await run(true));
  const secondText = await run(false);
  expect(files(root)).toEqual(changed);
  expect(first).toMatchObject({ advisory_only: true, controller_quality_state: 'read', controller_quality_invalid_rows: 0 });
  expect(first.controller_quality[0]).toMatchObject({ lane: 'fake-lane', score: 0.2, to: 0.3 });
  expect(second.controller_quality[0]).toMatchObject({ lane: 'fake-lane', score: 0.9, to: 0.9 });
  expect(first.proposals).toEqual(second.proposals);
  expect(first.proposals).toEqual([expect.objectContaining({ lane: 'fake-lane', status: 'proposed', known_n: 20, proposed_weight: 0.6, shift: 0.1 })]);
  expect(firstText).toContain('score=0.2');
  expect(secondText).toContain('score=0.9');
  expect(secondText).toContain('advisory-only: not applied to routing or weights.json');
});

it.each(['missing', 'invalid'] as const)('reports %s controller evidence as unknown and leaves files untouched', async kind => {
  if (kind === 'invalid') writeFileSync(join(runs, 'queue', 'fleet-controller.json'), '{broken');
  const before = files(root);
  const report = JSON.parse(await run(true));
  const text = await run(false);
  expect(report).toMatchObject({ advisory_only: true, controller_quality_state: kind, controller_quality: null, controller_quality_invalid_rows: null });
  expect(report.proposals).toEqual([expect.objectContaining({ lane: 'fake-lane', proposed_weight: 0.6 })]);
  expect(text).toContain(`controller-quality coverage: fleet-controller.json ${kind}`);
  expect(text).not.toContain('no lane-quality verdicts recorded');
  expect(files(root)).toEqual(before);
});
