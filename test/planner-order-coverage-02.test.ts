import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import { orderCoverageBriefLines } from '../src/core/fleet/planner-order-coverage.js';
import { buildPlannerBrief, type PlannerBriefGit } from '../src/core/fleet/planner-brief.js';

function trace(): OrderTraceV1 {
  return {
    v: 1, generatedAt: '2026-11-02T00:00:00Z',
    sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
    orders: [
      { at: '2026-10-31 19:28 ET', key: '10-31 19:28', source: 'Mason', jobs: [] },
      { at: '2026-11-01 00:08 ET', key: '11-01 00:08', source: 'desktop', jobs: [
        { id: 'RQ-PHX-FAKEA', state: 'queued', lane: null, url: null },
        { id: 'RQ-PHX-FAKEB', state: 'launched', lane: null, url: null },
      ] },
    ],
  };
}
it('summarizes unserved orders and counts sorted states chronologically', () => {
  expect(orderCoverageBriefLines(trace())).toEqual([
    '10-31 19:28 Mason: UNSERVED',
    '11-01 00:08 desktop: 2 job(s) (launched 1, queued 1)',
  ]);
});
it('reports only degraded sources before the newest tail', () => {
  const data = trace();
  data.sources.inbox = 'missing'; data.sources.publishes = 'degraded';
  expect(orderCoverageBriefLines(data, 1)).toEqual([
    '(degraded sources: inbox missing, publishes degraded)',
    '11-01 00:08 desktop: 2 job(s) (launched 1, queued 1)',
  ]);
  expect(orderCoverageBriefLines(trace(), 0)).toEqual([]);
});
it('strips source controls before capping the source at 40 characters', () => {
  const data = trace();
  data.orders[0]!.source = '\n\t\0\u007f\u0085' + 'x'.repeat(45);
  expect(orderCoverageBriefLines(data)[0]).toBe(`10-31 19:28 ${'x'.repeat(40)}: UNSERVED`);
});
it('reports an empty trace', () => {
  const data = trace(); data.orders = []; data.sources.inbox = 'missing';
  expect(orderCoverageBriefLines(data)).toEqual(['(no timestamped orders)']);
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const git: PlannerBriefGit = (_program, _args, _options, done) => done(null, '');
it('injects coverage directly before the inbox and preserves the brief when absent', async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), 'order-coverage-')); roots.push(runsRoot);
  const baseline = await buildPlannerBrief({ runsRoot, git });
  const brief = await buildPlannerBrief({ runsRoot, git, orderCoverage: async () => trace() });
  const section = `## ORDER COVERAGE\nOrders marked UNSERVED have no job citing them; prefer them.\n${orderCoverageBriefLines(trace()).join('\n')}\n`;
  expect(brief.text).toContain(`${section}## MASON INBOX (newest last)`);
  expect(brief.sections.orderCoverage).toBe(2);
  expect(brief.text.replace(section, '')).toBe(baseline.text);
  expect(baseline.text).not.toContain('## ORDER COVERAGE');
  expect(baseline.sections).not.toHaveProperty('orderCoverage');
});
it('renders failed coverage reads and records the missing source', async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), 'order-coverage-')); roots.push(runsRoot);
  const brief = await buildPlannerBrief({ runsRoot, git, orderCoverage: async () => { throw new Error('failed'); } });
  expect(brief.text).toContain('(unavailable: order coverage read failed)');
  expect(brief.missing).toContain('order-coverage');
  expect(brief.sections.orderCoverage).toBe(1);
});
