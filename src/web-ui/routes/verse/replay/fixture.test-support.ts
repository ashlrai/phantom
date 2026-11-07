import { REPLAY_SCHEMA } from './replay-model.js';

/** Synthetic finished run, shaped exactly like persisted Verse events. */
export function fixtureRecording() {
  const base = { at: '2026-10-26T06:00:00.000Z', turnId: 'turn-fixture' };
  return {
    schema: REPLAY_SCHEMA,
    title: 'Fix the greeting',
    events: [
      { ...base, seq: 1, type: 'user-message', text: 'Change the greeting to Hello.' },
      { ...base, seq: 2, type: 'turn-started', pid: null },
      { ...base, seq: 3, type: 'tool-use', toolUseId: 'edit', name: 'Edit', input: { file_path: 'hello.ts', old_string: "export const hello = 'Hi';", new_string: "export const hello = 'Hello';" } },
      { ...base, seq: 4, type: 'tool-result', toolUseId: 'edit', output: 'File updated.', isError: false },
      { ...base, seq: 5, type: 'tool-use', toolUseId: 'test', name: 'Bash', input: { command: 'npm test -- hello.test.ts' } },
      { ...base, seq: 6, type: 'tool-result', toolUseId: 'test', output: '1 test passed. Exit code: 0', isError: false },
      { ...base, seq: 7, type: 'text-delta', text: 'Updated' },
      { ...base, seq: 8, type: 'assistant-message', text: 'Updated the greeting. The test passes.' },
      { ...base, seq: 9, type: 'turn-done', ok: true, nativeSessionId: null, durationMs: 2000 },
    ] as Record<string, unknown>[],
  };
}
