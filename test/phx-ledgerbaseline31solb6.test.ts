import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdResourceLedger } from '../src/cli/resource-ledger.js';
import type { ResourceLedgerV1, ResourceLaneRow } from '../src/core/fleet/runs-resource-ledger.js';

const at = '2026-10-31T12:00:00Z';
const now = Date.parse(at);
const row = (lane: string): ResourceLaneRow => ({ lane, running: 1, target: 2, held: true,
  window: 'weekly', usedPct: 20, resetAt: '2026-11-01T00:00:00Z', source: 'status',
  creditsRemaining: null, burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, deadSignal: null });
const ledger = (): ResourceLedgerV1 => ({ v: 1, generatedAt: at, asOf: at,
  sources: { status: 'healthy', jobs: 'missing', apiSpend: 'degraded' },
  lanes: ['claude', 'codex-personal', 'grok', 'local'].map(row), apiSpend: null, jobsMalformedRows: null });
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(data: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'ledger-baseline-'));
  roots.push(root);
  const path = join(root, 'snapshot.json');
  await writeFile(path, typeof data === 'string' ? data : JSON.stringify(data));
  return path;
}
async function invoke(prior: ResourceLedgerV1, current: ResourceLedgerV1) {
  const path = await fixture(prior);
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const read = vi.fn().mockResolvedValue(current);
  expect(await cmdResourceLedger(['--json', '--compare-file', path], read, undefined, () => now)).toBe(0);
  expect(read).toHaveBeenCalledOnce();
  return JSON.parse(String(out.mock.calls.at(-1)![0]));
}
it('compares a saved fixture by exact IDs and preserves the full current ledger and source quality', async () => {
  const prior = ledger();
  const current = ledger();
  current.lanes.reverse();
  Object.assign(current.lanes.find(r => r.lane === 'claude')!, { usedPct: 27, running: 2, target: 3, held: false });
  const result = await invoke(prior, current);
  const { comparison, ...full } = result;
  expect(full).toEqual(current);
  expect(comparison.baselineSources).toEqual(prior.sources);
  expect(comparison.lanes.find((r: ResourceLaneRow) => r.lane === 'claude')).toMatchObject({
    usagePointDelta: 7, reason: null, runningChanged: true, targetChanged: true, holdChanged: true,
    prior: { usedPct: 20, held: true }, current: { usedPct: 27, held: false },
  });
});
it.each([
  ['window-transition', { usedPct: 1, resetAt: '2026-11-08T00:00:00Z' }],
  ['unknown-meter', { usedPct: null }],
  ['unknown-window', { resetAt: null }],
  ['counter-decreased', { usedPct: 1 }],
  ['unknown-or-changed-source', { source: 'another-source' }],
  ['unknown-meter', { window: 'credits', usedPct: null, creditsRemaining: 10 }],
] as const)('reports %s without zero-filling or negative burn', async (reason, fields) => {
  const prior = ledger();
  const current = ledger();
  Object.assign(current.lanes[0]!, fields);
  if ('window' in fields && fields.window === 'credits') Object.assign(prior.lanes[0]!, fields);
  const result = await invoke(prior, current);
  expect(result.comparison.lanes[0]).toMatchObject({ usagePointDelta: null, reason });
});
it('reports removed and added lanes without conflating IDs', async () => {
  const current = ledger();
  current.lanes[0]!.lane = 'claude-other';
  const result = await invoke(ledger(), current);
  expect(result.comparison.lanes.find((r: ResourceLaneRow) => r.lane === 'claude')).toMatchObject({ reason: 'removed-lane', current: null, usagePointDelta: null });
  expect(result.comparison.lanes.find((r: ResourceLaneRow) => r.lane === 'claude-other')).toMatchObject({ reason: 'added-lane', prior: null });
});
it.each(['prior', 'current'] as const)('rejects stale %s observations', async side => {
  const prior = ledger(); const current = ledger();
  (side === 'prior' ? prior : current).asOf = '2026-10-31T11:00:00Z';
  const result = await invoke(prior, current);
  expect(result.comparison.lanes[0]).toMatchObject({ reason: 'stale-or-invalid-observation', usagePointDelta: null });
});
it('uses lane observations and accepts an old baseline that was fresh at capture', async () => {
  const prior = ledger();
  prior.generatedAt = prior.asOf = '2026-10-30T12:00:00Z';
  const current = ledger();
  current.asOf = null;
  for (const lane of current.lanes) lane.observation = { source: 'codex-personal-sessions', asOf: at };
  const result = await invoke(prior, current);
  expect(result.comparison.lanes[0].usagePointDelta).toBe(0);
});
it.each(['{', ' '.repeat(1024 * 1024 + 1), JSON.stringify({ ...ledger(), v: 2 }),
  JSON.stringify({ ...ledger(), lanes: [row('duplicate'), row('duplicate')] }),
  JSON.stringify({ ...ledger(), lanes: [{ lane: 'broken' }] }),
  JSON.stringify({ ...ledger(), laneFilter: {} }),
])('rejects malformed, oversized or partial baselines before reading current evidence (%#)', async data => {
  const path = await fixture(data);
  const read = vi.fn();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  expect(await cmdResourceLedger(['--json', '--compare-file', path], read)).toBe(1);
  expect(read).not.toHaveBeenCalled();
});
it('refuses symlink baselines', async () => {
  const path = await fixture(ledger());
  await symlink(path, `${path}.link`);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  expect(await cmdResourceLedger(['--json', '--compare-file', `${path}.link`], vi.fn())).toBe(1);
});
it.each([[], ['--json', '--watch'], ['--json', '--lane', 'claude'], ['--json', '--model', 'model']].map(args => ({ args })))('rejects incompatible options before I/O (%#)', async ({ args }) => {
  const read = vi.fn();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  expect(await cmdResourceLedger([...args, '--compare-file', 'snapshot.json'], read)).toBe(2);
  expect(read).not.toHaveBeenCalled();
});
it('documents capture and compare commands without reading evidence', async () => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const read = vi.fn();
  expect(await cmdResourceLedger(['--help'], read)).toBe(0);
  expect(out.mock.calls.flat().join('\n')).toContain('phm resources ledger --json > snapshot.json');
  expect(read).not.toHaveBeenCalled();
});
