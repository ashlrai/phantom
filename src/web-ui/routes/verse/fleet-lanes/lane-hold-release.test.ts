import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { holdKind, LANE_HOLDS_PATH, postReleaseHold, releaseLabel } from './lane-hold-release.js';

beforeEach(() => { clearMutationToken(); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('classifies missing, automatic and manual reasons', () => {
  expect(holdKind(null)).toBeNull();
  expect(holdKind('')).toBeNull();
  expect(holdKind('autobackoff: usage')).toBe('autobackoff');
  expect(holdKind('operator hold')).toBe('manual');
});

it('labels future local expiry times and omits invalid or elapsed expiries', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 31, 16, 2));
  const future = new Date(2026, 9, 31, 17, 5).toISOString();
  expect(releaseLabel('autobackoff', future, Date.now())).toBe('Release hold (expires 17:05)');
  for (const value of [null, 'invalid', new Date(Date.now()).toISOString(), new Date(Date.now() - 1).toISOString()]) {
    expect(releaseLabel('autobackoff', value, Date.now())).toBe('Release hold');
  }
  expect(releaseLabel('manual', future, Date.now())).toBe('Held by hand');
});

it('requires a mutation token before making a request', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(postReleaseHold('codex-personal', 'reset detected')).rejects.toBeInstanceOf(VerseControlLockedError);
  expect(fetcher).not.toHaveBeenCalled();
});

it('maps a missing endpoint to the update message', async () => {
  setMutationToken('a'.repeat(64));
  const fetcher = vi.fn(async (_url: string) => Response.json({ error: 'not found' }, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(postReleaseHold('codex-personal', 'reset detected')).rejects.toThrow('This Phantom server cannot release holds yet; update the app.');
  expect(fetcher.mock.calls[0]?.[0]).toBe(LANE_HOLDS_PATH);
});
