import { describe, expect, it } from 'vitest';
import { bridgeHealBacklogItems, BRIDGE_HEAL_RECURRING_EVENTS } from '../src/core/improve/bridge-heal-backlog.js';
import type { LedgerTailRead } from '../src/core/router/outcomes.js';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const row = (event: string, at: string) => JSON.stringify({ schema: 'phm.bridge.source-heal/1', at, event, ok: event !== 'failed', reason: 'r' });
const read = (text: string, truncated = false): (() => Promise<LedgerTailRead>) => async () => ({ state: 'read', text, truncated });
const opts = (text: string, extra: Record<string, unknown> = {}) => ({
  repo: 'ashlrai/phantom', journalPath: '/x/bridge-source-repair.jsonl',
  readTail: read(text), now: NOW, ...extra,
});

describe('bridgeHealBacklogItems', () => {
  it('emits one item per recurring signal kind inside the window', async () => {
    const at = (d: number) => new Date(NOW - d * 86400000).toISOString();
    const text = [
      ...Array.from({ length: BRIDGE_HEAL_RECURRING_EVENTS }, (_, i) => row('failed', at(i + 1))),
      ...Array.from({ length: BRIDGE_HEAL_RECURRING_EVENTS }, (_, i) => row('skipped', at(i + 1))),
      row('probe', at(1)), row('probe', at(2)),
    ].join('\n');
    const items = await bridgeHealBacklogItems(opts(text));
    expect(items.map((i) => i.id)).toEqual([
      expect.stringMatching(/^bridge-heal-/), expect.stringMatching(/^bridge-heal-/),
    ]);
    expect(items[0]!.area).toBe('bridge-heal');
    expect(items[0]!.repo).toBe('ashlrai/phantom');
    expect(items.some((i) => i.title.includes('failing'))).toBe(true);
    expect(items.some((i) => i.title.includes('skipped'))).toBe(true);
    // 'probe' is the healthy path and never emits.
    expect(items.every((i) => !i.title.includes('probe'))).toBe(true);
  });

  it('returns no items below the recurring bar or for probe-only journals', async () => {
    const at = new Date(NOW - 86400000).toISOString();
    const few = await bridgeHealBacklogItems(opts([row('failed', at), row('failed', at)].join('\n')));
    expect(few).toEqual([]);
    const probes = await bridgeHealBacklogItems(opts([row('probe', at), row('probe', at), row('probe', at)].join('\n')));
    expect(probes).toEqual([]);
  });

  it('ignores rows outside the window and malformed lines', async () => {
    const old = new Date(NOW - 30 * 86400000).toISOString();
    const recent = new Date(NOW - 86400000).toISOString();
    const text = [row('failed', old), row('failed', old), row('failed', old), 'not json', row('failed', recent)].join('\n');
    const items = await bridgeHealBacklogItems(opts(text));
    expect(items).toEqual([]); // only one in-window 'failed'
  });

  it('returns no items for a missing/unreadable journal and non-fleet repos', async () => {
    expect(await bridgeHealBacklogItems({ repo: 'ashlrai/phantom', journalPath: '/x', readTail: async () => ({ state: 'missing' }), now: NOW })).toEqual([]);
    expect(await bridgeHealBacklogItems(opts('', { repo: 'someone/else' }))).toEqual([]);
  });
});
