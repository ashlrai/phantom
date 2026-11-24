import { afterEach, expect, it, vi } from 'vitest';
import { symlink } from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetVitals, readFleetVitalsView, readHostVitals } from '../src/cli/fleet-vitals.js';
import { readLocalGateEvidence, runLocalGate, type LocalGateExecResult, type LocalGateReport } from '../src/core/fleet/local-gate.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const SHA = 'a'.repeat(40);
const report = (over: Partial<LocalGateReport> = {}): LocalGateReport => ({
  verdict: 'pass', headSha: SHA, baseSha: SHA, seconds: 42.5,
  steps: [
    { name: 'typecheck', ok: true, seconds: 30 },
    { name: 'verify-changed', ok: true, seconds: 12.5 },
  ],
  ...over,
});

async function fixture(rows: unknown[] | string) {
  const root = await mkdtemp(join(tmpdir(), 'local-gate-vitals-')); roots.push(root);
  await mkdir(join(root, 'metrics'), { recursive: true });
  const text = typeof rows === 'string' ? rows : rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(join(root, 'metrics/local-gate.jsonl'), text);
  return root;
}

it('reports unknown evidence when the ledger is absent, empty or unreadable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-gate-vitals-')); roots.push(root);
  await mkdir(join(root, 'metrics'), { recursive: true });
  expect(await readLocalGateEvidence(root)).toEqual({
    source: 'missing', state: 'unknown', reports: 0, invalidRows: 0, passed: 0, failed: 0, steps: [], last: null,
  });
  await writeFile(join(root, 'metrics/local-gate.jsonl'), '');
  expect(await readLocalGateEvidence(root)).toMatchObject({ source: 'healthy', state: 'unknown', reports: 0 });
  await writeFile(join(root, 'private'), JSON.stringify(report()));
  await rm(join(root, 'metrics/local-gate.jsonl'));
  await symlink(join(root, 'private'), join(root, 'metrics/local-gate.jsonl'));
  expect(await readLocalGateEvidence(root)).toMatchObject({ source: 'degraded', state: 'unknown', reports: 0 });
});

it('tallies verdicts and per-step failures and keeps the newest valid report', async () => {
  const root = await fixture([
    report(),
    report({ verdict: 'fail', steps: [
      { name: 'typecheck', ok: true, seconds: 30 },
      { name: 'verify-changed', ok: false, seconds: 12.5 },
      { name: 'budget', ok: false, seconds: 0 },
    ] }),
    report({ verdict: 'fail', steps: [
      { name: 'typecheck', ok: false, seconds: 30 },
      { name: 'verify-changed', ok: false, seconds: 12.5 },
    ] }),
  ]);
  const evidence = await readLocalGateEvidence(root);
  expect(evidence).toMatchObject({
    source: 'healthy', state: 'known', reports: 3, invalidRows: 0, passed: 1, failed: 2,
    last: { verdict: 'fail', seconds: 42.5, failedSteps: ['typecheck', 'verify-changed'] },
  });
  // Worst failure count first; equal counts order by name.
  expect(evidence.steps).toEqual([
    { name: 'verify-changed', runs: 3, failures: 2 },
    { name: 'budget', runs: 1, failures: 1 },
    { name: 'typecheck', runs: 3, failures: 1 },
  ]);
});

it('ignates malformed rows without erasing valid evidence', async () => {
  const root = await fixture('not json\n' + JSON.stringify(report()) + '\n{"verdict":"maybe"}\n' + JSON.stringify(report({ verdict: 'fail' })) + '\n');
  const evidence = await readLocalGateEvidence(root);
  expect(evidence).toMatchObject({ source: 'degraded', state: 'known', reports: 2, invalidRows: 2, passed: 1, failed: 1 });
  expect(evidence.last?.verdict).toBe('fail');
});

it.each([
  ['non-object row', '"text"'],
  ['unknown verdict', JSON.stringify({ ...report(), verdict: 'skip' })],
  ['bad head sha', JSON.stringify({ ...report(), headSha: 'xyz' })],
  ['missing steps', JSON.stringify({ verdict: 'pass', headSha: SHA, baseSha: SHA, seconds: 1 })],
  ['negative seconds', JSON.stringify(report({ seconds: -1 }))],
  ['oversized step list', JSON.stringify(report({ steps: Array.from({ length: 17 }, (_, i) => ({ name: `s${i}`, ok: true, seconds: 0 })) }))],
])('rejects %s', async (_label, line) => {
  const root = await fixture(line + '\n');
  expect(await readLocalGateEvidence(root)).toMatchObject({ source: 'degraded', state: 'unknown', reports: 0, invalidRows: 1 });
});

it('reads what runLocalGate writes: verdict, steps and projection only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-gate-roundtrip-')); roots.push(root);
  const exec = async (command: string, args: string[]): Promise<LocalGateExecResult> => {
    const out = (stdout: string): LocalGateExecResult => ({ ok: true, stdout, stderr: '' });
    if (command === 'git' && args[0] === 'rev-parse') return out(`${SHA}\n`);
    if (command === 'git' && args[0] === 'merge-base') return out(`${SHA}\n`);
    if (command === 'node' && args[0] === 'scripts/verify-changed.mjs') return { ok: false, stdout: '', stderr: 'FAIL tsc' };
    return out('');
  };
  const written = await runLocalGate(180, { cwd: root, exec, metricsPath: join(root, 'metrics/local-gate.jsonl') });
  expect(written.verdict).toBe('fail');
  const evidence = await readLocalGateEvidence(root);
  expect(evidence).toMatchObject({ source: 'healthy', state: 'known', reports: 1, passed: 0, failed: 1 });
  expect(evidence.steps).toEqual(expect.arrayContaining([
    { name: 'typecheck', runs: 1, failures: 0 },
    { name: 'verify-changed', runs: 1, failures: 1 },
  ]));
  expect(evidence.last).toMatchObject({ verdict: 'fail', failedSteps: ['verify-changed'] });
  // Ledger rows carry only the report fields; nothing else is projected.
  expect(JSON.stringify(evidence)).not.toContain('must-not-escape');
});

it('adds local_gate to the vitals view without touching the HostVitals shape', async () => {
  const root = await fixture([report(), report({ verdict: 'fail' })]);
  const view = await readFleetVitalsView(root, Date.now());
  expect(view.local_gate).toMatchObject({ state: 'known', reports: 2, passed: 1, failed: 1 });
  expect(Object.keys(await readHostVitals(root, Date.now())).sort())
    .toEqual(['disk', 'emptyCauses', 'launch', 'launchCost', 'local_models', 'schema', 'status', 'stuck']);
});

it('prints the gate line and emits local_gate in --json output', async () => {
  const root = await fixture([report(), report({ verdict: 'fail', steps: [
    { name: 'typecheck', ok: true, seconds: 30 }, { name: 'verify-changed', ok: false, seconds: 12 },
  ] })]);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetVitals(['--runs-dir', root, '--json'])).toBe(0);
  const json = JSON.parse(String(log.mock.calls[0]![0]));
  expect(json.local_gate).toMatchObject({ state: 'known', reports: 2, passed: 1, failed: 1 });
  expect(json.local_gate.last.failedSteps).toEqual(['verify-changed']);
  log.mockClear();
  expect(await cmdFleetVitals(['--runs-dir', root])).toBe(0);
  const lines = log.mock.calls.map(call => String(call[0]));
  expect(lines.some(line => line.startsWith('Local gate: 1/2 reports passed'))).toBe(true);
  expect(lines.some(line => line.includes('verify-changed x1'))).toBe(true);
});

it('prints unknown, never a zeroed guess, when no ledger exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-gate-vitals-')); roots.push(root);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetVitals(['--runs-dir', root])).toBe(0);
  expect(log.mock.calls.map(call => String(call[0]))).toContain('Local gate: unknown (source missing)');
});
