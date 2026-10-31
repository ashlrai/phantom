import { describe, expect, it } from 'vitest';
import { diffFleetForPush, sanitizePushDetail, type PushFleetSnapshot } from '../src/core/web/remote-push-fleet.js';

const snapshot = (): PushFleetSnapshot => ({
  mergesLastHour: { count: 0, items: [] }, claudeLane: 'up',
  lanes: [{ lane: 'codex-personal', running: 1, target: 1, queued: 0, held: false,
    heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
});
const merge = (number: number, title = 'bridge: work') => ({ repo: 'phantom', number, title });

describe('fleet push diff', () => {
  it('baselines without notifications', () => {
    const current = snapshot();
    current.mergesLastHour.items = [merge(1)];
    current.lanes[0].held = true;
    current.claudeLane = 'down';
    expect(diffFleetForPush(null, current)).toEqual([]);
  });
  it.each([1, 3])('groups %i new merges, newest first', (count) => {
    const previous = snapshot();
    previous.mergesLastHour.items = [merge(10)];
    const current = snapshot();
    current.mergesLastHour.items = [...Array.from({ length: count }, (_, i) => merge(20 - i)), merge(10)];
    expect(diffFleetForPush(previous, current)).toEqual([
      { kind: 'fleet-merged', count, detail: '#20 bridge: work' },
    ]);
  });
  it('notifies a held transition once, with no recovery alert', () => {
    const previous = snapshot(); const current = snapshot();
    current.lanes[0].held = true; current.lanes[0].heldReason = 'usage_limit';
    expect(diffFleetForPush(previous, current)).toEqual([
      { kind: 'fleet-lane-held', detail: 'codex-personal: usage_limit' },
    ]);
    expect(diffFleetForPush(current, current)).toEqual([]);
    expect(diffFleetForPush(current, previous)).toEqual([]);
  });
  it('reports a newly down claude lane only once', () => {
    const current = { ...snapshot(), claudeLane: 'down usage_limit' };
    expect(diffFleetForPush(snapshot(), current)).toEqual([
      { kind: 'fleet-lane-held', detail: 'claude: down usage_limit' },
    ]);
    expect(diffFleetForPush(current, current)).toEqual([]);
  });
  it('scrubs secrets and home paths before clipping both summaries', () => {
    const current = snapshot();
    current.mergesLastHour.items = [merge(21, '/Users/x/private sk-abc123 ' + 'a'.repeat(200))];
    current.lanes[0].held = true; current.lanes[0].heldReason = '/Users/x/private sk-abc123\n';
    for (const intent of diffFleetForPush(snapshot(), current)) {
      expect(intent.detail).not.toMatch(/\/Users\/|~\/|sk-abc123|\n/);
      expect(intent.detail!.length).toBeLessThanOrEqual(120);
    }
  });
  it('bounds details, strips control bytes and clips merge titles to 80 characters', () => {
    expect(sanitizePushDetail('word '.repeat(50))).toHaveLength(120);
    expect(sanitizePushDetail('a\u0000\u001fb\u007f\u009fc')).toBe('abc');
    const current = snapshot();
    current.mergesLastHour.items = [merge(20, 'word '.repeat(50))];
    expect(diffFleetForPush(snapshot(), current)[0].detail).toBe('#20 ' + 'word '.repeat(16));
  });
  it('emits at most one held intent when multiple lanes fail', () => {
    const previous = snapshot();
    previous.lanes.push({ ...previous.lanes[0], lane: 'other' });
    const current = structuredClone(previous);
    current.lanes.forEach((lane) => { lane.held = true; });
    current.claudeLane = 'down';
    expect(diffFleetForPush(previous, current)).toHaveLength(1);
  });
});
