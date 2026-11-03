import { describe, expect, it } from 'vitest';
import { interjectOutcome } from '../src/web-ui/routes/verse/fleet/interject-outcome-model.js';
import { narrowOrderTrace, type OrderTraceJob, type OrderTraceV1 } from '../src/web-ui/routes/verse/fleet-inbox/order-trace-model.js';

const AT = '2026-11-01 00:08 ET';
const pr = (n: number, host = 'github.com/ashlrai/phantom') => `https://${host}/pull/${n}`;
const trace = (jobs: OrderTraceJob[]): OrderTraceV1 => ({
  v: 1, generatedAt: '2026-11-01T05:00:00Z', sources: { inbox: null, prompts: null, publishes: null },
  orders: [{ at: AT, source: 'Phantom desktop', key: '11-01 00:08', jobs }],
});
const job = (state: OrderTraceJob['state'], url: string | null = null, id = 'RQ-PHX-FAKE01'): OrderTraceJob => ({ id, lane: null, state, url });

describe('interjectOutcome', () => {
  it('sent when nothing is known', () => expect(interjectOutcome(AT, false, null)).toEqual({ stage: 'sent', text: 'sent' }));
  it('acked without a trace', () => expect(interjectOutcome(AT, true, null)).toEqual({ stage: 'acked', text: 'acked' }));
  it('job running', () => expect(interjectOutcome(AT, true, trace([job('launched')]))).toEqual({ stage: 'job', text: 'job RQ-PHX-FAKE01 running' }));
  it('merged links the PR', () => expect(interjectOutcome(AT, true, trace([job('merged', pr(1234))])))
    .toEqual({ stage: 'merged', text: 'merged #1234', href: 'https://github.com/ashlrai/phantom/pull/1234' }));
  it('two jobs, one merged: merged wins', () => expect(interjectOutcome(AT, false, trace([job('launched', null, 'RQ-A'), job('merged', pr(77), 'RQ-B')])).stage).toBe('merged'));
  it('matches by timestamp key when the heading differs', () =>
    expect(interjectOutcome('2026-11-01 00:08', false, trace([job('queued')])).stage).toBe('job'));
  it('no link for a PR on another repo', () => expect(interjectOutcome(AT, true, trace([job('merged', pr(5, 'github.com/other/repo'))])))
    .toEqual({ stage: 'merged', text: 'merged' }));
  it('no link without a numeric PR', () => expect(interjectOutcome(AT, true, trace([job('merged', 'https://github.com/ashlrai/phantom/pull/abc')])).href).toBeUndefined());
  it('malformed trace gives sent', () => expect(interjectOutcome(AT, false, narrowOrderTrace({ v: 1, orders: 'x' }))).toEqual({ stage: 'sent', text: 'sent' }));
  it('unknown for an entry without a time', () => expect(interjectOutcome('—', true, null).stage).toBe('unknown'));
});
