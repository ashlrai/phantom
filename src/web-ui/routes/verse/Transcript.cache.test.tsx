/**
 * Transcript.cache.test.tsx — a chat's derived turns outlive its transcript's
 * unmount: switching away and back re-derives nothing when the store hands
 * back the same transcript, and another chat never sees the first one's turns.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { VerseEvent } from '../../data/api-types.js';
import { ev } from './fixtures.test-support.js';
import { Transcript } from './Transcript.js';
import { buildTranscript } from './verse-transcript.js';

const derivations = vi.hoisted(() => ({ count: 0 }));
vi.mock('./chat/turn-model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat/turn-model.js')>();
  return { ...actual, buildTurns: (...args: Parameters<typeof actual.buildTurns>) => { derivations.count += 1; return actual.buildTurns(...args); } };
});

function chat(prefix: string): VerseEvent[] {
  const turnId = `${prefix}-t0`;
  return [
    ev(1, 'user-message', { turnId, text: `ask ${prefix}` }),
    ev(2, 'assistant-message', { turnId, text: `answer ${prefix}` }),
    ev(3, 'turn-done', { turnId, ok: true, nativeSessionId: null, durationMs: 100 }),
  ];
}

describe('Transcript — derived turns kept across a chat switch', () => {
  it('re-derives nothing when switching back to the same transcript', () => {
    const a = buildTranscript(chat('a'));
    const b = buildTranscript(chat('b'));
    const view = render(<Transcript transcript={a} loaded loadError={null} sessionId="cache-a" />);
    view.unmount();
    const other = render(<Transcript transcript={b} loaded loadError={null} sessionId="cache-b" />);
    expect(other.container.textContent).toContain('answer b');
    expect(other.container.textContent).not.toContain('answer a');
    other.unmount();

    derivations.count = 0;
    const back = render(<Transcript transcript={a} loaded loadError={null} sessionId="cache-a" />);
    expect(back.container.textContent).toContain('answer a');
    expect(derivations.count).toBe(0);
  });
});
