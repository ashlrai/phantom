import { describe, expect, it } from 'vitest';
import { envelopeRows } from './agent-bus-model.js';
import type { AgentBusReceipt } from './agent-bus-queries.js';
import {
  APP_ACTION_PENDING_MS, appActionEntry, appActionEnvelopeSummary, appActionNeedsAttention, appActionRows, appActionStateWord,
  appActionTitle, appActionTone, appActionTook, appActionWaitsOnYou,
} from './app-action-envelope.js';

const T0 = Date.parse('2026-11-18T12:00:00Z');
let n = 0;
/** One envelope as core/apps-control.ts `defaultFeed` posts it. */
const feed = (cursor: number, atMs: number, body: Record<string, unknown>, from = 'apps-control'): AgentBusReceipt => ({
  cursor, receivedAt: atMs, envelope: { id: `apps-control-${++n}`, from, to: 'mason', priority: 'P3', ttl: 604_800_000, body: { kind: 'apps-control', ...body } },
});

describe('app action envelopes', () => {
  it('reads only well-formed apps-control entries', () => {
    expect(appActionEntry(feed(1, T0, { phase: 'start', action: 'quit', app: 'Slack' }).envelope))
      .toEqual({ phase: 'start', action: 'quit', app: 'Slack', outcome: null, detail: '' });
    expect(appActionEntry(feed(1, T0, { phase: 'result', action: 'quit', app: 'Slack', outcome: 'refused', detail: ' not\u0000 in list. ' }).envelope))
      .toMatchObject({ outcome: 'refused', detail: 'not in list.' });
    // Another sender using the same kind is not an app action, and neither is a malformed entry.
    expect(appActionEntry(feed(1, T0, { phase: 'start', action: 'quit', app: 'Slack' }, 'codex-worker').envelope)).toBeNull();
    expect(appActionEntry(feed(1, T0, { phase: 'start', action: 'erase', app: 'Slack' }).envelope)).toBeNull();
    expect(appActionEntry(feed(1, T0, { phase: 'later', action: 'quit', app: 'Slack' }).envelope)).toBeNull();
    expect(appActionEntry(feed(1, T0, { phase: 'start', action: 'quit', app: ' ' }).envelope)).toBeNull();
    expect(appActionEntry({ from: 'apps-control', body: 'quit Slack' })).toBeNull();
  });

  it('says unknown for a result whose outcome it does not recognise', () => {
    expect(appActionEntry(feed(1, T0, { phase: 'result', action: 'open', app: 'Figma', outcome: 'teleported' }).envelope)?.outcome).toBe('unknown');
    expect(appActionEntry(feed(1, T0, { phase: 'result', action: 'open', app: 'Figma' }).envelope)?.outcome).toBe('unknown');
  });

  it('pairs each result with the oldest unanswered start for the same action and app', () => {
    const rows = appActionRows([
      feed(4, T0 + 1_300, { phase: 'result', action: 'quit', app: 'Slack', outcome: 'done', detail: 'quit.' }),
      feed(1, T0, { phase: 'start', action: 'quit', app: 'Slack' }),
      feed(2, T0 + 100, { phase: 'start', action: 'open', app: 'Figma' }),
      feed(3, T0 + 400, { phase: 'result', action: 'open', app: 'Figma', outcome: 'needs-you', detail: 'Sent to needs-you.' }),
    ], T0 + 5_000);
    expect(rows.map(row => [appActionTitle(row), row.state, row.tookMs, row.at])).toEqual([
      ['Open Figma', 'needs-you', 300, new Date(T0 + 400).toISOString()],
      ['Quit Slack', 'done', 1_300, new Date(T0 + 1_300).toISOString()],
    ]);
  });

  it('keeps a result whose start was not read, with no invented duration', () => {
    const [row] = appActionRows([feed(9, T0, { phase: 'result', action: 'restart', app: 'Cursor', outcome: 'failed', detail: 'timed out.' })], T0);
    expect(row).toMatchObject({ state: 'failed', tookMs: null, detail: 'timed out.' });
  });

  it('reads a start with no result as in progress, then as no result recorded', () => {
    const start = feed(1, T0, { phase: 'start', action: 'focus', app: 'Notes' });
    expect(appActionRows([start], T0 + APP_ACTION_PENDING_MS - 1)[0]?.state).toBe('running');
    expect(appActionRows([start], T0 + APP_ACTION_PENDING_MS)[0]?.state).toBe('unrecorded');
  });

  it('counts a repeated envelope once and never pairs across apps', () => {
    const start = feed(1, T0, { phase: 'start', action: 'quit', app: 'Slack' });
    const other = feed(2, T0 + 50, { phase: 'result', action: 'quit', app: 'Safari', outcome: 'done' });
    const rows = appActionRows([start, { ...start, cursor: 3 }, other], T0 + APP_ACTION_PENDING_MS * 2);
    expect(rows.map(row => [row.app, row.state, row.tookMs])).toEqual([['Slack', 'unrecorded', null], ['Safari', 'done', null]]);
  });

  it('puts every state into words, a tone and a duration', () => {
    expect(appActionTitle({ action: 'list', app: '*' })).toBe('List allowed apps');
    expect(appActionTitle({ action: 'status', app: 'Claude' })).toBe('Check Claude');
    expect((['done', 'running', 'needs-you', 'needs_permission', 'refused', 'failed', 'unknown', 'unrecorded'] as const).map(appActionTone))
      .toEqual(['ok', 'live', 'warn', 'warn', 'bad', 'bad', 'unknown', 'unknown']);
    expect(appActionStateWord('needs_permission')).toBe('needs a macOS permission');
    expect(appActionStateWord('unrecorded')).toBe('no result recorded');
    expect([appActionWaitsOnYou('needs-you'), appActionWaitsOnYou('refused'), appActionNeedsAttention('refused'), appActionNeedsAttention('done'), appActionNeedsAttention('running')])
      .toEqual([true, false, true, false, false]);
    expect([appActionTook(null), appActionTook(340), appActionTook(1_240), appActionTook(12_600)]).toEqual([null, '340 ms', '1.2 s', '13 s']);
  });

  it('gives the Bus pane one readable line per envelope instead of JSON', () => {
    const start = feed(1, T0, { phase: 'start', action: 'quit', app: 'Slack' });
    const result = feed(2, T0 + 10, { phase: 'result', action: 'quit', app: 'Slack', outcome: 'refused', detail: 'that app is never available to agents.' });
    expect(appActionEnvelopeSummary(start.envelope)).toEqual({ label: 'app action', text: 'Quit Slack: started' });
    expect(envelopeRows([start, result], T0 + 20).map(row => row.excerpt)).toEqual([
      'app action — Quit Slack: refused. that app is never available to agents.', 'app action — Quit Slack: started',
    ]);
    expect(appActionEnvelopeSummary({ from: 'leader', body: { kind: 'ack', text: 'ok' } })).toBeNull();
  });
});
