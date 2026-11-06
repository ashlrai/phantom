import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlannerBrief, type PlannerBriefGit } from '../src/core/fleet/planner-brief.js';
import { wasteRiskBriefLines } from '../src/core/fleet/planner-waste.js';
import type { WasteRiskProjection } from '../src/core/resources/waste-risk.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'brief-waste-'));
  roots.push(root);
  await mkdir(join(root, 'leader/drop'), { recursive: true });
  await mkdir(join(root, 'queue'));
  return root;
}
const git: PlannerBriefGit = (_program, _args, _options, done) => { done(null, ''); };
const HEADING = '## WASTE RISK (lanes projected to leave capacity unused at reset; prefer them)';

const row = (lane: string, waste_risk: WasteRiskProjection['waste_risk'], used: number | null, unused: number | null, extra: Partial<WasteRiskProjection> = {}): WasteRiskProjection => ({
  lane, reset_at: '2026-11-05T00:00:00Z', hours_to_reset: 12.34, window_remaining_fraction: 0.2,
  projected_used_at_reset: used, projected_unused_at_reset: unused, waste_risk, recommended_target: 3, ...extra,
});
const ROWS = [
  row('med-lane', 'medium', 90, 10),
  row('low-lane', 'low', 99, 1),
  row('unk-lane', 'unknown', null, null, { hours_to_reset: null, recommended_target: null }),
  row('high-lane', 'high', 50, 50),
];

it('renders the section after LANES with high before medium, no low, and the unknown count', async () => {
  const root = await fixture();
  const brief = await buildPlannerBrief({ runsRoot: root, git, wasteRisk: async () => ROWS });
  const start = brief.text.indexOf(HEADING);
  expect(start).toBeGreaterThan(brief.text.indexOf('## LANES'));
  const section = brief.text.slice(start, brief.text.indexOf('## USED IDS'));
  expect(section).toContain('high-lane high 50% projected unused at reset in 12.3 h, recommended target 3');
  expect(section).toContain('med-lane medium 10% projected unused at reset in 12.3 h, recommended target 3');
  expect(section.indexOf('high-lane')).toBeLessThan(section.indexOf('med-lane'));
  expect(section).not.toContain('low-lane');
  expect(section).toContain('(1 lanes with unknown usage evidence)');
  expect(brief.sections).toMatchObject({ wasteRisk: 3 });
  expect(brief.missing).not.toContain('waste-risk');
});

it('renders unavailable and records missing when the read throws', async () => {
  const root = await fixture();
  const base = await buildPlannerBrief({ runsRoot: root, git, now: 1 });
  const brief = await buildPlannerBrief({ runsRoot: root, git, now: 1, wasteRisk: async () => { throw new Error('boom'); } });
  expect(brief.text).toContain(`${HEADING}\n(unavailable: waste-risk read failed)`);
  expect(brief.missing).toContain('waste-risk');
  expect(brief.text.replace(/## WASTE RISK[^\n]*\n[^\n]*\n/, '')).toBe(base.text);
});

it('omits the section and the sections key without the option', async () => {
  const root = await fixture();
  const brief = await buildPlannerBrief({ runsRoot: root, git });
  expect(brief.text).not.toContain('## WASTE RISK');
  expect(brief.sections).not.toHaveProperty('wasteRisk');
});

it('strips control characters, caps names, and handles the none case', () => {
  const [line] = wasteRiskBriefLines([row('a\u0000b\u001b[31m\nc' + 'x'.repeat(60), 'high', 50, 50)]);
  // eslint-disable-next-line no-control-regex -- asserting control characters are gone.
  expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  expect(line!.split(' high ')[0]!.length).toBeLessThanOrEqual(40);
  expect(wasteRiskBriefLines([row('x', 'low', 99, 1)])).toEqual(['(none: no lane is projected to waste capacity)']);
  expect(wasteRiskBriefLines([row('x', 'unknown', null, null)])).toEqual(['(none: no lane is projected to waste capacity)', '(1 lanes with unknown usage evidence)']);
  const many = Array.from({ length: 25 }, (_, i) => row(`l${i}`, 'high', 50, 50));
  expect(wasteRiskBriefLines(many)).toHaveLength(21);
});
