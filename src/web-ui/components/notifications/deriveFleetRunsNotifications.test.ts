import { describe, expect, it } from 'vitest';
import { deriveFleetRunsNotifications as derive } from './deriveFleetRunsNotifications.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  generatedAt: new Date(now).toISOString(), paused: false, claudeLane: 'healthy',
  lanes: [], workers: [{ ageSeconds: 60 }], mergesLastHour: { count: 0 },
  drop: null, events: [], ...overrides,
});
const lane = (name: string, held = false) => ({ lane: name, held, running: 0, target: 1, queued: 2 });

describe('fleet run incidents', () => {
  it.each([null, undefined, {}, { generatedAt: 'bad' }, snapshot({ lanes: [null] }), snapshot({ workers: [{}] })])(
    'ignores missing or unknown shapes: %j', (value) => expect(derive(value, now)).toEqual([]),
  );

  it.each([
    [1800, 0, false, true], [1740, 0, false, false], [2040, null, false, false],
    [2040, 0, true, false], [2040, 1, false, false],
  ])('stall boundary: age=%s merges=%s paused=%s', (ageSeconds, count, paused, fires) => {
    expect(derive(snapshot({ workers: [{ ageSeconds }], mergesLastHour: { count }, paused }), now)
      .some((n) => n.id === 'fleet-stall')).toBe(fires);
  });

  it('uses the youngest worker, then the latest start event, then unknown', () => {
    expect(derive(snapshot({ workers: [{ ageSeconds: 2040 }, { ageSeconds: 60 }] }), now)).toEqual([]);
    const events = [{ kind: 'launch', at: new Date(now - 2040_000).toISOString() },
      { kind: 'start', at: new Date(now - 60_000).toISOString() }];
    expect(derive(snapshot({ workers: [], events }), now)).toEqual([]);
    expect(derive(snapshot({ workers: [{ ageSeconds: null }], events: events.slice(0, 1) }), now)[0])
      .toMatchObject({ id: 'fleet-stall', detail: 'Nothing started for 34 min and nothing merged in the last hour.' });
    expect(derive(snapshot({ workers: [], events: [{ kind: 'merge', at: new Date(now).toISOString() }] }), now)[0])
      .toMatchObject({ id: 'fleet-stall', detail: 'Last start is unknown and nothing merged in the last hour.' });
  });

  it.each(['down', 'REJECTED', 'invalid'])('redacts token-like Claude lane status: %s', (status) => {
    const out = derive(snapshot({ claudeLane: `${status}: ${'x'.repeat(40)}` }), now);
    expect(out).toEqual([{ id: 'fleet-claude-lane-down', category: 'fleet', severity: 'high',
      title: 'Claude lane is down', detail: `${status}: …`, ts: new Date(now).toISOString() }]);
  });

  it('emits stable ids in severity order, counts drop files and never copies worker/inbox text', () => {
    const data = snapshot({ workers: [{ ageSeconds: 2040, text: 'private worker' }], inbox: 'private inbox',
      claudeLane: 'down', lanes: [lane('idle'), { ...lane('held', true), heldReason: 'waiting for credits' },
        lane('other', true), lane('second'), { ...lane('busy'), running: 1 }, { ...lane('empty'), queued: 0 }],
      drop: { pending: [{ lane: 'a', file: 'private file' }, { lane: 'b', file: 'other file' }], done: 0 },
    });
    const out = derive(data, now);
    expect(out.map((n) => [n.id, n.severity])).toEqual([
      ['fleet-stall', 'critical'], ['fleet-claude-lane-down', 'high'],
      ['fleet-lane-held-held', 'medium'], ['fleet-lane-held-other', 'medium'],
      ['fleet-lane-idle-idle', 'low'], ['fleet-lane-idle-second', 'low'], ['fleet-drop-pending', 'info'],
    ]);
    expect(out[2]?.detail).toContain('waiting for credits');
    expect(out.at(-1)?.detail).toBe('2 leader job files waiting for ingest');
    expect(out.every((n) => n.category === 'fleet' && n.ts === data.generatedAt && !n.actionHref)).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/private|other file/);
    expect(derive(data, now + 1000).map((n) => n.id)).toEqual(out.map((n) => n.id));
    expect(derive(snapshot({ drop: { pending: [], done: 2 } }), now)).toEqual([]);
  });
});
