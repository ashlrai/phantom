import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeterWatchLog } from './meter-watch-model.js';
import { METER_WATCH_STORAGE_KEY, loadMeterWatchLog, saveMeterWatchLog } from './meter-watch-store.js';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');

/** Minimal in-memory Storage stand-in — the reload boundary the tests cross. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key); },
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
  } as Storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('meter-watch-store', () => {
  it('round-trips the log through a fake localStorage', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const log: MeterWatchLog = {
      'codex-personal': [
        { at: NOW - 61 * 60_000, usedPct: 40, creditsRemaining: null },
        { at: NOW, usedPct: 40, creditsRemaining: null },
      ],
      claude: [{ at: NOW, usedPct: null, creditsRemaining: 90 }],
    };
    saveMeterWatchLog(log);
    // A "reload": the module reads back only what storage kept.
    expect(loadMeterWatchLog()).toEqual(log);
  });

  it('yields an empty log for missing, corrupt or wrongly-shaped storage', () => {
    for (const raw of [undefined, '{', 'null', '[]', '42', '"x"', '{"codex":"nope"}', '{"codex":[1,2]}']) {
      const storage = fakeStorage(raw === undefined ? {} : { [METER_WATCH_STORAGE_KEY]: raw });
      vi.stubGlobal('localStorage', storage);
      expect(loadMeterWatchLog(), `raw=${raw}`).toEqual({});
    }
  });

  it('keeps valid lane entries and valid samples when siblings are malformed', () => {
    vi.stubGlobal('localStorage', fakeStorage({
      [METER_WATCH_STORAGE_KEY]: JSON.stringify({
        good: [{ at: NOW, usedPct: 40, creditsRemaining: null }, { at: 'soon', usedPct: 40 }],
        bad: 'not-an-array',
      }),
    }));
    expect(loadMeterWatchLog()).toEqual({ good: [{ at: NOW, usedPct: 40, creditsRemaining: null }] });
  });

  it('writes under the phantom.meterWatch.v1 key and never throws on storage failure', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    saveMeterWatchLog({ codex: [{ at: NOW, usedPct: 40, creditsRemaining: null }] });
    expect(storage.getItem(METER_WATCH_STORAGE_KEY)).toContain('"codex"');

    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(loadMeterWatchLog()).toEqual({});
    expect(() => saveMeterWatchLog({ codex: [] })).not.toThrow();
  });
});
