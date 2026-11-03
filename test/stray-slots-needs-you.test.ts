import { describe, expect, it } from 'vitest';
import type { StraySlotsV1 } from '../src/core/fleet/stray-slots.js';
import { deriveStraySlotsNeedsYou } from '../src/web-ui/routes/verse/shell/stray-slots-needs-you.js';

const report = (slots: number, source: StraySlotsV1['source'] = 'ok'): StraySlotsV1 => ({
  v: 1, generatedAt: '2026-11-03T00:00:00Z', source,
  lanes: [{ lane: 'fake-lane', slotsLost: slots, strays: [{ job: 'fake-job', pid: 4242, ageSeconds: 60 }] }],
});
const derive = (value?: StraySlotsV1 | null) => deriveStraySlotsNeedsYou(value, 0);
describe('stray slots Needs-you', () => {
  it('omits missing, unavailable and zero readings', () => {
    for (const value of [undefined, null, report(3, 'unavailable'), report(0)]) expect(derive(value)).toEqual([]);
  });
  it('reports one lost slot as attention', () => {
    expect(derive(report(1))[0]).toMatchObject({ id: 'stray-slots', severity: 'attention', title: '1 lane slot lost to leftover processes' });
  });
  it('reports three lost slots as urgent and lists affected lanes', () => {
    const value = report(1);
    value.lanes.push({ lane: 'fake-other', slotsLost: 2, strays: [] });
    expect(derive(value)[0]).toMatchObject({ severity: 'urgent', title: '3 lane slots lost to leftover processes', detail: 'fake-lane: 1 · fake-other: 2', open: { kind: 'pane', paneId: 'fleet-lanes' } });
  });
});
