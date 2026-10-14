import type { VerseNativeSessionBinding } from '../../../../core/verse/native-session-binding-types.js';

export function binding(over: Partial<VerseNativeSessionBinding> = {}): VerseNativeSessionBinding {
  return { schemaVersion: 1, scope: 'native-session-binding', source: 'phantom-session-metadata', sessionId: 'vs_1',
    engine: 'codex', seatId: 'codex-main', nativeSessionId: 'conversation_1', nativeIdState: 'recorded',
    savedStatus: 'running', savedUpdatedAt: '2026-10-14T00:00:00.000Z', liveOwnerState: 'unverified',
    desktopAttachment: 'unverified', controlEnabled: false, ...over };
}
