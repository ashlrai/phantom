import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEEDS_YOU_SOURCES } from '../src/core/verse/workbench-types.js';
import { diffNeedsMasonForPush, validNeedsMasonItems } from '../src/core/web/remote-push-needs-mason.js';
import { createRemotePushWatcher } from '../src/core/web/remote-push-watcher.js';

const item = (n: number, text = `fake item ${n}`) => ({ id: `nm-${n.toString(16).padStart(12, '0')}`, text });
const sources = Object.fromEntries(NEEDS_YOU_SOURCES.map((source) => [source, 'ok']));
const activity = (cursor: string, ids: string[] = []) => ({
  cursor, needsYou: ids.map((id) => ({ id, source: 'fleet' })), completions: [], sources,
});
const fleet = { mergesLastHour: { items: [] }, lanes: [], claudeLane: null };

describe('needs-mason push diff', () => {
  it('treats the first read as a baseline', () => {
    const { intent, ids } = diffNeedsMasonForPush(null, [item(1)]);
    expect(intent).toBeNull();
    expect([...ids]).toEqual([item(1).id]);
  });

  it('reports one new id with sanitized detail', () => {
    const text = `fake  token sk-abc123 \u0007 ${'x'.repeat(200)}`;
    const { intent } = diffNeedsMasonForPush(new Set([item(1).id]), [item(1), item(2, text)]);
    expect(intent).toMatchObject({ kind: 'needs-you', count: 1 });
    expect(intent?.detail).not.toContain('sk-abc123');
    expect(intent?.detail).not.toContain('\u0007');
    expect(intent?.detail.length).toBeLessThanOrEqual(120);
  });

  it('does not push when an item is resolved', () => {
    const { intent, ids } = diffNeedsMasonForPush(new Set([item(1).id, item(2).id]), [item(1)]);
    expect(intent).toBeNull();
    expect([...ids]).toEqual([item(1).id]);
  });

  it('rejects invalid input', () => {
    expect(validNeedsMasonItems([item(1)])).toBe(true);
    expect(validNeedsMasonItems('nope')).toBe(false);
    expect(validNeedsMasonItems([{ id: 'bad', text: 'fake' }])).toBe(false);
    expect(validNeedsMasonItems([{ id: item(1).id, text: 5 }])).toBe(false);
    expect(validNeedsMasonItems([null])).toBe(false);
    expect(validNeedsMasonItems(Array.from({ length: 501 }, (_, n) => item(n)))).toBe(false);
  });
});

describe('watcher needs-mason polling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  function build(opts: { read?: () => Promise<unknown>; mason: () => Promise<unknown> }) {
    const send = vi.fn(async () => undefined);
    const watcher = createRemotePushWatcher({
      read: opts.read ?? (async () => activity('c')), readFleet: async () => fleet,
      readNeedsMason: opts.mason, send, timeoutMs: 25,
    });
    return { send, watcher };
  }

  it('sends nothing on the first poll, then one needs-you for a new item', async () => {
    let items = [item(1)];
    const { send, watcher } = build({ mason: async () => items });
    await watcher.pollOnce();
    expect(send).not.toHaveBeenCalled();
    items = [item(1), item(2, 'fake approval wanted')];
    await watcher.pollOnce();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('needs-you', { count: 1, detail: 'fake approval wanted' });
  });

  it('keeps the baseline across a throwing read', async () => {
    const mason = vi.fn<() => Promise<unknown>>()
      .mockResolvedValueOnce([item(1)])
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([item(1), item(2)])
      .mockResolvedValueOnce([item(1), item(2)]);
    const { send, watcher } = build({ mason });
    await watcher.pollOnce();
    await watcher.pollOnce();
    await watcher.pollOnce();
    await watcher.pollOnce();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends a single push when activity and needs-mason both find a need', async () => {
    let items = [item(1)];
    let ids: string[] = [];
    const { send, watcher } = build({ read: async () => activity('c', ids), mason: async () => items });
    await watcher.pollOnce();
    items = [item(1), item(2)];
    ids = ['fresh'];
    await watcher.pollOnce();
    expect(send.mock.calls.filter(([kind]) => kind === 'needs-you')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
