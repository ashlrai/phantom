import { describe, expect, it } from 'vitest';
import { narrowSlackBridge, slackBridgeLine, type SlackBridgeView } from './slack-bridge-model.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const base: SlackBridgeView = {
  v: 1, at: '2026-11-19T12:00:00Z', configState: 'ok', slackSection: 'ok', ready: true, botTokenRefSet: true, appTokenRefSet: true,
  topics: ['a', 'b'], slackIdentities: 1, confirmedByMason: true,
  journal: { state: 'ok', ingested: 3, ignored: 1, lastAt: '2026-11-19T11:56:00Z' }, transport: 'unknown', next: null,
};

describe('narrowSlackBridge', () => {
  it('accepts a valid view', () => expect(narrowSlackBridge(base)).toEqual(base));
  it.each([null, 'x', [], {}, { ...base, v: 2 }, { ...base, ready: 'yes' }, { ...base, topics: [1] },
    { ...base, journal: null }, { ...base, journal: { ...base.journal, ingested: -1 } }, { ...base, slackSection: 'bad' }, { ...base, next: 4 }])(
    'rejects junk %#', (v) => expect(narrowSlackBridge(v)).toBeNull());
});

describe('slackBridgeLine', () => {
  const all: string[] = [];
  const line = (v: SlackBridgeView) => { const l = slackBridgeLine(v, NOW); all.push(l.text, l.next ?? ''); return l; };
  it('ready with age', () => expect(line(base)).toEqual({ tone: 'ok', text: 'Slack bridge ready · 2 topics · last message 4m ago · connection unverified', next: null }));
  it('ready, no messages', () => expect(line({ ...base, journal: { ...base.journal, lastAt: null } }).text)
    .toBe('Slack bridge ready · 2 topics · no messages yet · connection unverified'));
  it('not ready', () => expect(line({ ...base, ready: false, next: 'do x' })).toEqual({ tone: 'warn', text: 'Slack bridge not ready · connection unverified', next: 'do x' }));
  it('not set up', () => {
    expect(line({ ...base, configState: 'missing', slackSection: 'absent', ready: false, next: 'create it' }))
      .toEqual({ tone: 'muted', text: 'Slack bridge not set up · connection unverified', next: 'create it' });
    expect(line({ ...base, slackSection: 'absent', ready: false }).tone).toBe('muted');
  });
  it('unreadable', () => expect(line({ ...base, configState: 'unreadable', ready: false }))
    .toMatchObject({ tone: 'muted', text: 'Slack bridge status unknown · connection unverified' }));
  it('never says connected or live', () => {
    for (const t of all) expect(t).not.toMatch(/\bconnected\b|\blive\b/i);
  });
});
