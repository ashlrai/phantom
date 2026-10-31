/**
 * mobile-switches-model.test.ts — the merge of the two readings: the runs
 * snapshot's observed file names and the control route's own list, the
 * honesty rules (missing source → "—", never "off"), and the confirmation
 * sheet's exact wording.
 */
import { describe, expect, it } from 'vitest';
import { confirmText, KNOWN_SWITCHES, readSwitches } from './mobile-switches-model.js';

function snapshot(switches: string[], runsDir = 'healthy'): unknown {
  return { v: 1, sources: { runsDir }, switches };
}

function control(over: Record<string, boolean> = {}, extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    sourceState: 'healthy',
    switches: KNOWN_SWITCHES.map((k) => ({ id: k.id as string, on: over[k.id] ?? false, since: null as string | null, effect: `${k.id} effect` })),
    ...extra,
  };
}

describe('KNOWN_SWITCHES', () => {
  it('lists the six switch ids in card order, matching the control route', () => {
    expect(KNOWN_SWITCHES.map((k) => k.id)).toEqual(['HOLD', 'PAUSE', 'ORCH_OFF', 'OPUS_LEADER_OFF', 'PUBLISH_HOLD', 'QUEUE_DISABLE']);
    for (const k of KNOWN_SWITCHES) {
      expect(k.label).toBeTruthy();
      expect(k.meaning).toBeTruthy();
    }
  });
});

describe('readSwitches', () => {
  it('reads the snapshot alone when the control route is absent', () => {
    const view = readSwitches(snapshot(['HOLD']), null);
    expect(view.writable).toBe(false);
    expect(view.sourceState).toBe('healthy');
    expect(view.rows).toHaveLength(6);
    expect(view.rows.find((r) => r.id === 'HOLD')?.on).toBe(true);
    for (const row of view.rows.filter((r) => r.id !== 'HOLD')) expect(row.on).toBe(false);
  });

  it('maps queue/DISABLE to QUEUE_DISABLE', () => {
    const view = readSwitches(snapshot(['queue/DISABLE']), null);
    expect(view.rows.find((r) => r.id === 'QUEUE_DISABLE')?.on).toBe(true);
  });

  it('a missing runs dir says nothing: every on is null, never off', () => {
    const view = readSwitches(snapshot([], 'missing'), null);
    expect(view.sourceState).toBe('missing');
    expect(view.rows.every((r) => r.on === null)).toBe(true);
    expect(readSwitches(snapshot([], 'not-landed'), null).rows.every((r) => r.on === null)).toBe(true);
  });

  it('a degraded read keeps observed switches on but cannot call the rest off', () => {
    const view = readSwitches(snapshot(['PAUSE'], 'degraded'), null);
    expect(view.sourceState).toBe('degraded');
    expect(view.rows.find((r) => r.id === 'PAUSE')?.on).toBe(true);
    expect(view.rows.find((r) => r.id === 'HOLD')?.on).toBeNull();
  });

  it('an unreadable source list still trusts observed names but not absences', () => {
    const view = readSwitches({ switches: ['HOLD'] }, null);
    expect(view.rows.find((r) => r.id === 'HOLD')?.on).toBe(true);
    expect(view.rows.find((r) => r.id === 'PAUSE')?.on).toBeNull();
    expect(view.sourceState).toBe('unknown');
  });

  it('the control route wins and makes the card writable', () => {
    const view = readSwitches(snapshot(['HOLD']), control({ PAUSE: true }));
    expect(view.writable).toBe(true);
    expect(view.rows.find((r) => r.id === 'PAUSE')?.on).toBe(true);
    expect(view.rows.find((r) => r.id === 'HOLD')?.on).toBe(false);
  });

  it('falls back to the snapshot for a switch the control read does not list', () => {
    const partial = control();
    partial.switches = partial.switches.filter((r) => r.id !== 'QUEUE_DISABLE');
    const view = readSwitches(snapshot(['queue/DISABLE']), partial);
    expect(view.writable).toBe(true);
    expect(view.rows.find((r) => r.id === 'QUEUE_DISABLE')?.on).toBe(true);
  });

  it('a malformed control body is not the route: read-only, snapshot still read', () => {
    expect(readSwitches(snapshot(['HOLD']), { v: 1, switches: 'nope' }).writable).toBe(false);
    expect(readSwitches(snapshot(['HOLD']), { v: 1, switches: [{ id: 'HOLD', on: 'yes' }] }).writable).toBe(false);
    const view = readSwitches(snapshot(['HOLD']), { v: 1, switches: 'nope' });
    expect(view.rows.find((r) => r.id === 'HOLD')?.on).toBe(true);
  });

  it('neither source: six rows, all unknown', () => {
    const view = readSwitches(null, null);
    expect(view.writable).toBe(false);
    expect(view.sourceState).toBe('unknown');
    expect(view.rows.every((r) => r.on === null)).toBe(true);
  });
});

describe('confirmText', () => {
  it('wording for pausing workers is the spec sentence', () => {
    const text = confirmText('PAUSE', true);
    expect(text.title).toBe('Pause workers on your Mac?');
    expect(text.body).toBe('Running jobs finish; nothing new starts.');
    expect(text.confirmLabel).toBe('Pause workers');
  });

  it('has a distinct resume wording for the off direction', () => {
    expect(confirmText('PAUSE', false).title).toBe('Resume workers on your Mac?');
    expect(confirmText('HOLD', true).title).toBe('Hold all dispatch on your Mac?');
    expect(confirmText('HOLD', false).title).toBe('Lift the dispatch hold?');
  });

  it('covers every known switch in both directions', () => {
    for (const k of KNOWN_SWITCHES) {
      for (const on of [true, false]) {
        const text = confirmText(k.id, on);
        expect(text.title.endsWith('?')).toBe(true);
        expect(text.body.length).toBeGreaterThan(0);
        expect(text.confirmLabel.length).toBeGreaterThan(0);
        expect(text.done.length).toBeGreaterThan(0);
      }
    }
  });
});
