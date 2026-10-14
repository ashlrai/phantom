import { describe, expect, it, vi } from 'vitest';
import { validVerseNativeSessionBinding, type VerseNativeSessionBinding } from '../src/core/verse/native-session-binding-types.js';
const binding: VerseNativeSessionBinding = { schemaVersion: 1, scope: 'native-session-binding', source: 'phantom-session-metadata',
  sessionId: 'chat-1', engine: 'codex', seatId: 'codex:owner', nativeSessionId: 'thread-1', nativeIdState: 'recorded',
  savedStatus: 'running', savedUpdatedAt: '2026-10-14T01:02:03.000Z', liveOwnerState: 'unverified', desktopAttachment: 'unverified', controlEnabled: false };
describe('browser-safe saved binding contract', () => {
  it('accepts only saved evidence, including explicit missing/invalid/unsupported states', () => {
    expect(validVerseNativeSessionBinding(binding)).toBe(true);
    for (const nativeIdState of ['not-created', 'invalid'] as const) expect(validVerseNativeSessionBinding({ ...binding, nativeSessionId: null, nativeIdState })).toBe(true);
    expect(validVerseNativeSessionBinding({ ...binding, engine: 'grok', nativeSessionId: null, nativeIdState: 'unsupported' })).toBe(true);
  });
  it.each([{ controlEnabled: true }, { liveOwnerState: 'running' }, { desktopAttachment: 'attached' }, { extra: 'PRIVATE' },
    { engine: ['grok'] }, { savedStatus: ['running'] }, { seatId: '/PRIVATE' }, { nativeSessionId: '--resume' },
    { nativeSessionId: 'id?query' }, { nativeSessionId: 'x'.repeat(129) }, { nativeIdState: 'unsupported' },
    { engine: 'local' }, { savedUpdatedAt: '2026-02-30T00:00:00.000Z' }, { savedUpdatedAt: '2026-10-14' }])('refuses unsafe or contradictory projection %#', patch => {
    expect(validVerseNativeSessionBinding({ ...binding, ...patch })).toBe(false);
  });
  it('refuses getters, coercion hooks, non-records and symbol fields without invoking them', () => {
    const getter = vi.fn(() => 'codex');
    const accessor = Object.defineProperty({ ...binding }, 'engine', { get: getter });
    const hook = vi.fn(() => 'grok');
    for (const value of [null, [], accessor, Object.assign({ ...binding }, { [Symbol('extra')]: true }),
      { ...binding, engine: { toString: hook }, nativeSessionId: null, nativeIdState: 'unsupported' }]) expect(validVerseNativeSessionBinding(value)).toBe(false);
    expect(getter).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled();
  });
});
