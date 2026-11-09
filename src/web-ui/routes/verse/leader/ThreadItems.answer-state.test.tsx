import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { answerStates } from './answer-state.js';
import { ThreadRows, type ThreadContext } from './ThreadItems.js';
import { msg } from './thread-fixtures.test-support.js';
import { groupThread, type ThreadEntry } from './thread-model.js';

afterEach(cleanup);

const T0 = Date.parse('2026-11-09T10:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function show(messages: ReturnType<typeof msg>[], nowMin: number) {
  const ctx: ThreadContext = {
    leader: null,
    actions: { act: vi.fn(), busy: false, error: null, clearError: vi.fn(), readOnly: false, dialogs: null },
    answered: new Map(), answerStates: answerStates(messages, T0 + nowMin * 60_000), byId: new Map(), answering: new Set(), focusQuestionId: null,
    answerDraft: () => '', setAnswerDraft: vi.fn(), onAnswer: vi.fn(), onRetry: vi.fn(), onDiscard: vi.fn(),
    sendDisabledReason: null, dormant: false,
  };
  const entries: ThreadEntry[] = messages.map((message) => ({ type: 'message', key: message.id, at: message.at, message }));
  return render(<ThreadRows rows={groupThread(entries)} ctx={ctx} />);
}

it('shows answered and waiting lines under Mason bubbles', () => {
  show([
    msg({ id: 'm1', from: 'mason', at: at(0), text: 'first' }),
    msg({ id: 'l1', at: at(2), text: 'reply' }),
    msg({ id: 'm2', from: 'mason', at: at(3), text: 'second' }),
  ], 17);
  expect(screen.getByText('Answered in 2m')).toBeInTheDocument();
  const waiting = screen.getByText('Waiting for the Leader · 14m');
  expect(waiting).toHaveAttribute('data-overdue', 'true');
});

it('labels the channel of a Mason message', () => {
  show([msg({ id: 'm1', from: 'mason', channel: 'imessage', at: at(0), text: 'hi' })], 1);
  expect(screen.getByText('via iMessage')).toBeInTheDocument();
  expect(screen.getByText('Waiting for the Leader · 1m')).not.toHaveAttribute('data-overdue');
});
