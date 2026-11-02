import { expect, it } from 'vitest';
import type { RunsHistory, RunsSample } from '../../../../core/fleet/runs-history.js';
import { NO_FLEET_TEXT } from '../fleet/no-fleet.js';
import { headline } from './capacity-model.js';

const at = '2026-10-31T12:00:00.000Z';
const history: RunsHistory = { v: 1, generatedAt: at, from: at, to: at, sourceState: 'missing', dropped: 0, samples: [] };
const sample: RunsSample = { at, lanes: [], workers: null, leaders: null, paused: null };

it('uses the shared notice only for missing history with no samples', () => {
  expect(headline(history, Date.parse(at))).toBe(NO_FLEET_TEXT);
  expect(headline({ ...history, sourceState: 'healthy' }, Date.parse(at))).toContain('No capacity history yet');
  expect(headline({ ...history, sourceState: 'degraded' }, Date.parse(at))).toContain('source degraded');
  expect(headline({ ...history, samples: [sample] }, Date.parse(at))).toContain('1 sample · 0 launch gaps · source missing');
});
