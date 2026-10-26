/**
 * Transcript.blocks.test.tsx — a streamed token re-renders the block of turns
 * holding the live turn, not every turn of a long chat, and a new ask does
 * not remount the turns already on screen.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { VerseEvent } from '../../data/api-types.js';
import { ev } from './fixtures.test-support.js';
import { Transcript } from './Transcript.js';
import { buildTranscript, createTranscriptCache } from './verse-transcript.js';

/** Turns the transcript asked about (one `isFull` per turn element it built). */
const asked = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock('./chat/turn-window.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat/turn-window.js')>();
  return {
    ...actual,
    useTurnWindow: (...args: Parameters<typeof actual.useTurnWindow>) => {
      const win = actual.useTurnWindow(...args);
      return { ...win, isFull: (key: string, index: number, running: boolean) => { asked.keys.push(key); return win.isFull(key, index, running); } };
    },
  };
});

const SETTLED = 80;

function settledTurns(): VerseEvent[] {
  const events: VerseEvent[] = [];
  let seq = 1;
  for (let i = 0; i < SETTLED; i++) {
    const turnId = `t${i}`;
    events.push(
      ev(seq++, 'user-message', { turnId, text: `ask ${i}` }),
      ev(seq++, 'assistant-message', { turnId, text: `answer ${i}` }),
      ev(seq++, 'turn-done', { turnId, ok: true, nativeSessionId: null, durationMs: 100 }),
    );
  }
  return events;
}

describe('Transcript — turn blocks', () => {
  it('asks about the live block only on a streamed token, and keeps every turn mounted across a new ask', () => {
    const cache = createTranscriptCache();
    const log = settledTurns();
    let seq = log.length + 1;
    log.push(ev(seq++, 'user-message', { turnId: 'live', text: 'go' }), ev(seq++, 'turn-started', { turnId: 'live', pid: 1 }));
    const view = render(<Transcript transcript={buildTranscript(log, { cache })} loaded loadError={null} />);
    expect(view.container.textContent).toContain('answer 0');
    const first = document.querySelector('[data-turn-key]')!;

    for (let i = 0; i < 3; i++) {
      asked.keys = [];
      log.push(ev(seq++, 'text-delta', { turnId: 'live', text: `word${i} ` }));
      view.rerender(<Transcript transcript={buildTranscript(log, { cache })} loaded loadError={null} />);
      expect(view.container.textContent).toContain(`word${i}`);
      expect(asked.keys.length).toBeGreaterThan(0);
      expect(asked.keys.length).toBeLessThan(SETTLED / 2);
    }

    log.push(
      ev(seq++, 'assistant-message', { turnId: 'live', text: 'done' }),
      ev(seq++, 'turn-done', { turnId: 'live', ok: true, nativeSessionId: null, durationMs: 100 }),
      ev(seq++, 'user-message', { turnId: 'next', text: 'and then?' }),
    );
    view.rerender(<Transcript transcript={buildTranscript(log, { cache })} loaded loadError={null} />);
    expect(view.container.textContent).toContain('and then?');
    expect(document.querySelector('[data-turn-key]')).toBe(first);
    expect(document.querySelectorAll('[data-turn-key]')).toHaveLength(SETTLED + 2);
  });
});
