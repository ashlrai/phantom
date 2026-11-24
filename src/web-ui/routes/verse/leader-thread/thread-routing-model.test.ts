import { describe, expect, it } from 'vitest';
import { narrowOrderTrace, type OrderTraceV1 } from '../fleet-inbox/order-trace-model.js';
import { inboxAtForLine, lineRouting, routingInFlight, routingSummary, UNROUTED_WINDOW_MS } from './thread-routing-model.js';

const AT = '2026-11-10 09:56';
const NOW = Date.parse('2026-11-10T15:30:00Z');
const PR = 'https://github.com/ashlrai/phantom/pull/4321';

function trace(jobs: unknown[], overrides: Record<string, unknown> = {}): OrderTraceV1 {
  const narrowed = narrowOrderTrace({
    v: 1, generatedAt: '2026-11-10T15:00:00Z', sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
    orders: [{ at: AT, source: 'Phantom desktop', key: '11-10 09:56', jobs }], ...overrides,
  });
  if (!narrowed) throw new Error('fixture did not narrow');
  return narrowed;
}

const fresh = { lineAtMs: NOW - 10 * 60_000, nowMs: NOW };

describe('inboxAtForLine', () => {
  const inbox = [{ at: AT, text: 'ship the judge fix' }, { at: '2026-11-10 10:02', text: 'same words' }, { at: '2026-11-10 10:05', text: 'same words' }];

  it('reads an inbox row by the index in its id', () => {
    expect(inboxAtForLine({ id: 'inbox-0', who: 'mason', source: 'Phantom desktop', text: 'ship the judge fix' }, inbox)).toBe(AT);
    expect(inboxAtForLine({ id: 'inbox-9', who: 'mason', source: 'Phantom desktop', text: 'gone' }, inbox)).toBeNull();
  });

  it('matches a relayed thread post only when its text names exactly one inbox row', () => {
    expect(inboxAtForLine({ id: 'm-1', who: 'mason', source: 'desktop', text: ' ship the judge fix ' }, inbox)).toBe(AT);
    expect(inboxAtForLine({ id: 'm-2', who: 'mason', source: 'desktop', text: 'same words' }, inbox)).toBeNull();
  });

  it('never routes leader, system, owner-channel or composer lines', () => {
    expect(inboxAtForLine({ id: 'inbox-0', who: 'leader', source: 'outbox', text: 'ship the judge fix' }, inbox)).toBeNull();
    expect(inboxAtForLine({ id: 'inbox-0', who: 'mason', source: 'system', text: 'ship the judge fix' }, inbox)).toBeNull();
    expect(inboxAtForLine({ id: 'owner-7', who: 'mason', source: 'imessage', text: 'ship the judge fix' }, inbox)).toBeNull();
    expect(inboxAtForLine({ id: 'composer-1-0', who: 'mason', source: 'desktop', text: 'ship the judge fix' }, inbox)).toBeNull();
  });
});

describe('lineRouting', () => {
  it('lists each job with its lane, stage reached, wording and link', () => {
    const routing = lineRouting(trace([
      { id: 'RQ-A', lane: 'devin', state: 'merged', url: PR },
      { id: 'RQ-B', lane: 'codex-personal', state: 'launched', url: null },
      { id: 'RQ-C', lane: null, state: 'queued', url: null },
    ]), AT, fresh);
    expect(routing?.state).toBe('routed');
    expect(routing?.jobs).toEqual([
      { id: 'RQ-A', lane: 'devin', state: 'merged', reached: 4, empty: false, word: 'merged #4321', href: PR, openable: true },
      { id: 'RQ-B', lane: 'codex-personal', state: 'launched', reached: 2, empty: false, word: 'launched', href: null, openable: true },
      { id: 'RQ-C', lane: null, state: 'queued', reached: 1, empty: false, word: 'queued', href: null, openable: false },
    ]);
    expect(routing?.summary).toBe('3 jobs · 2 lanes · 1 merged · 1 launched · 1 queued');
  });

  it('words a job that ended with nothing to publish, and keeps it out of the in-flight count', () => {
    const routing = lineRouting(trace([
      { id: 'RQ-A', lane: 'devin', state: 'launched', url: null, endedEmptyAt: '2026-11-10T15:10:00Z' },
      { id: 'RQ-B', lane: 'devin', state: 'published', url: PR },
    ]), AT, fresh);
    expect(routing?.jobs.map(job => job.word)).toEqual(['ended empty', 'PR #4321']);
    expect(routing?.summary).toBe('2 jobs · 1 lane · 1 published · 1 ended empty');
    expect(routingInFlight([routing, routing, null])).toBe(1);
  });

  it('drops a link that is not a plain github.com URL', () => {
    const routing = lineRouting(trace([{ id: 'RQ-A', lane: 'devin', state: 'published', url: 'https://evil.example/pull/1' }]), AT, fresh);
    expect(routing?.jobs[0]).toMatchObject({ href: null, word: 'published' });
  });

  it('says a fresh message no job cites is not routed yet', () => {
    expect(lineRouting(trace([]), AT, fresh)).toEqual({ state: 'unrouted', jobs: [], summary: 'Not routed to a lane yet' });
  });

  it('says unknown, not unrouted, when the prompt journals could not be read', () => {
    const degraded = trace([], { sources: { inbox: 'healthy', prompts: 'degraded', publishes: 'healthy' } });
    expect(lineRouting(degraded, AT, fresh)?.state).toBe('unknown');
  });

  it('stays silent without a trace, for an entry the trace does not hold, a status ask, or an old message', () => {
    expect(lineRouting(null, AT, fresh)).toBeNull();
    expect(lineRouting(trace([]), null, fresh)).toBeNull();
    expect(lineRouting(trace([]), '2026-11-09 08:00', fresh)).toBeNull();
    expect(lineRouting(trace([]), AT, { ...fresh, quiet: true })).toBeNull();
    expect(lineRouting(trace([]), AT, { lineAtMs: NOW - UNROUTED_WINDOW_MS - 1, nowMs: NOW })).toBeNull();
    expect(lineRouting(trace([]), AT, { lineAtMs: Number.NaN, nowMs: NOW })).toBeNull();
  });

  it('matches an "ET"-suffixed heading by its key and leaves a steer target to its own line', () => {
    const one = trace([{ id: 'RQ-A', lane: 'devin', state: 'launched', url: null }]);
    expect(lineRouting(one, `${AT} ET`, fresh)?.jobs.map(job => job.id)).toEqual(['RQ-A']);
    expect(lineRouting(one, AT, { ...fresh, skipJob: 'RQ-A' })).toBeNull();
  });
});

describe('routingSummary', () => {
  it('omits the lane count when no job names a lane', () => {
    expect(routingSummary([{ id: 'RQ-A', lane: null, state: 'queued', reached: 1, empty: false, word: 'queued', href: null, openable: false }])).toBe('1 job · 1 queued');
  });
});
