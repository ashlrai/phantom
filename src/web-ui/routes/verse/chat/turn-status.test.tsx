import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { VerseEvent } from '../../../../core/verse/types.js';
import { statusLine, turnAcknowledgement, turnResult } from '../../../../core/verse/turn-status.js';
import { bootstrap, session } from '../fixtures.test-support.js';
import { Sidebar } from '../Sidebar.js';
import { parseVerseEventFrame, VERSE_EVENT_TYPES } from '../verse-event-frame.js';
import { applyVerseEvent, getVerseSessionHead, resetVerseStore, seedVerseSession } from '../verse-store.js';
import { buildTranscript } from '../verse-transcript.js';

const event = (phase: 'acknowledgement' | 'result', text: string): Extract<VerseEvent, { type: 'assistant-status' }> => ({
  type: 'assistant-status', seq: phase === 'result' ? 3 : 1, at: '2026-10-26T12:00:00Z', turnId: 'task', phase, text,
});

beforeEach(resetVerseStore);

describe('assistant status copy', () => {
  it('names the accepted task in one short line, including control characters and long inputs', () => {
    expect(turnAcknowledgement('  Fix\n the\tparser\0  ')).toBe('I’m working on: Fix the parser');
    expect(statusLine('a'.repeat(200), 100)).toHaveLength(100);
    expect(statusLine('a'.repeat(200), 100)).toMatch(/…$/);
    expect(turnAcknowledgement('a'.repeat(200)).length).toBeLessThan(125);
  });

  it('reports the returned answer without claiming an empty turn completed the task', () => {
    expect(turnResult('Fix\nthe parser', 'Fixed\nwith tests.', 'ok')).toBe('Result for Fix the parser: Fixed with tests.');
    expect(turnResult('Fix the parser', ' ', 'ok')).toBe('Turn finished: Fix the parser. No response text was returned.');
    expect(turnResult('a'.repeat(200), 'b'.repeat(300), 'ok').length).toBeLessThan(280);
    expect(turnResult('Fix it', 'misleading partial success', 'failed')).toBe('Turn failed: Fix it');
    expect(turnResult('Fix it', 'misleading partial success', 'cancelled')).toBe('Stopped: Fix it');
  });
});

describe('assistant status delivery', () => {
  it('registers the named SSE event and validates its payload', () => {
    expect(VERSE_EVENT_TYPES).toContain('assistant-status');
    for (const phase of ['acknowledgement', 'result'] as const) {
      expect(parseVerseEventFrame(JSON.stringify(event(phase, 'Working')))).toEqual(event(phase, 'Working'));
    }
    for (const invalid of [{ phase: 'unknown' }, { text: null }, { turnId: null }]) {
      expect(parseVerseEventFrame(JSON.stringify({ ...event('result', 'Finished'), ...invalid }))).toBeNull();
    }
  });

  it('preserves partial model text beside lifecycle copy and applies the result to the live head', () => {
    const ack = event('acknowledgement', 'I’m working on: Fix it');
    const result = event('result', 'Result for Fix it: Investigated it');
    const events: VerseEvent[] = [ack, { ...ack, type: 'text-delta', seq: 2, text: 'Investigated it' }, result];
    expect(buildTranscript(events).items.flatMap(item => item.kind === 'assistant' ? [item.text] : []))
      .toEqual([ack.text, 'Investigated it', result.text]);
    seedVerseSession('chat', session({ id: 'chat', status: 'running' }), []);
    applyVerseEvent('chat', ack);
    expect(getVerseSessionHead('chat').session?.lastResult).toBeUndefined();
    applyVerseEvent('chat', result);
    expect(getVerseSessionHead('chat').session?.lastResult).toBe(result.text);
  });

  it('renders the durable result in an unread sidebar row and clears it when selected', () => {
    const boot = bootstrap();
    const result = 'Result for Fix the parser: Parser fixed; checks passed.';
    const props = {
      sessions: [session({ id: 'chat', turnCount: 1, lastResult: result })], sessionsStatus: 'success' as const,
      sessionsError: null, projects: boot.projects, seats: boot.seats, selectedId: 'another-chat', query: '',
      meta: { sessions: {} }, onQuery: () => {}, onSelect: () => {}, onNew: () => {},
      onRetry: () => {}, onCollapse: () => {}, onDisconnect: () => {},
    };
    const view = render(<Sidebar {...props} />);
    expect(screen.getByText(result)).toBeInTheDocument();
    view.rerender(<Sidebar {...props} selectedId="chat" />);
    expect(screen.queryByText(result)).not.toBeInTheDocument();
  });
});
