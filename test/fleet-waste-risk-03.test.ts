import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildWasteRiskInputs, type WasteRiskFacts } from '../src/core/resources/waste-risk-read.js';
import { projectWasteRisk } from '../src/core/resources/waste-risk.js';
import { cmdFleetWasteRisk } from '../src/cli/fleet-waste-risk.js';
import { notifyWasteRiskTransition } from '../src/core/resources/waste-risk-notify.js';
vi.mock('../src/core/integrations/desktop-notify.js', () => ({ desktopNotify: vi.fn(async () => true) }));
import { desktopNotify } from '../src/core/integrations/desktop-notify.js';
import type { AshlrConfig } from '../src/core/types.js';

const now = '2026-10-30T19:00:00Z';
const reset = '2026-10-31T00:00:00Z';
const facts: WasteRiskFacts = {
  lanes: [{ lane: 'fake-lane', running: 2, target: 8, held: false, queued: 3 }],
  meters: [18, 19].map(hour => ({ provider: 'fake-lane', window: 'primary:1200', usedPercent: 60, resetAt: reset, sampledAt: `2026-10-30T${hour}:00:00Z` })),
  ledger: { v: 1, generatedAt: now, asOf: null, lanes: [], apiSpend: null, jobsMalformedRows: null, sources: { status: 'missing', jobs: 'missing', apiSpend: 'missing' } },
};
afterEach(() => vi.restoreAllMocks());
it('maps evidence in percent units; missing burn stays null', () => {
  const [input] = buildWasteRiskInputs(facts, now);
  expect(input).toMatchObject({ used: 60, limit: 100, running: 2, ceiling: 8, held: false, burn_per_hour: 0, per_job_cost: null });
  expect(buildWasteRiskInputs({ ...facts, meters: facts.meters.slice(1) }, now)[0]?.burn_per_hour).toBeNull();
});
it('projects 40% unused with five hours to reset as high', () => {
  expect(projectWasteRisk(buildWasteRiskInputs(facts, now)[0]!)).toMatchObject({ waste_risk: 'high', projected_unused_at_reset: 40, hours_to_reset: 5 });
});
it('fails closed for paid lanes without a credit guard', () => {
  const input = buildWasteRiskInputs({ ...facts, overageLanes: ['fake-lane'] }, now)[0]!;
  expect(input.credit_guard).toBeNull();
  expect(projectWasteRisk(input).recommended_target).toBe(0);
});
it('keeps stale samples and reset crossings unknown', () => {
  expect(projectWasteRisk(buildWasteRiskInputs(facts, '2026-10-30T20:00:00Z')[0]!).waste_risk).toBe('unknown');
  const changed = { ...facts, meters: facts.meters.map((m, i) => ({ ...m, resetAt: i ? reset : '2026-10-30T20:00:00Z' })) };
  expect(buildWasteRiskInputs(changed, now)[0]?.burn_per_hour).toBeNull();
});
it('prints schema without writing; notify persists and suppresses repeated high', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'fake-waste-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const delivered = vi.mocked(desktopNotify);
  delivered.mockClear();
  const deps = { read: async () => buildWasteRiskInputs(facts, now), notify: notifyWasteRiskTransition, config: () => ({} as AshlrConfig) };
  try {
    expect(await cmdFleetWasteRisk(['--json', '--runs-dir', runsDir], deps)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).schema).toBe('fleet.waste-risk.v1');
    expect(await readdir(runsDir)).toEqual([]);
    for (let i = 0; i < 2; i++) expect(await cmdFleetWasteRisk(['--notify', '--runs-dir', runsDir], deps)).toBe(0);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(runsDir, 'queue/waste-risk-last.json'), 'utf8'))[0].waste_risk).toBe('high');
  } finally { await rm(runsDir, { recursive: true, force: true }); }
});
