import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThreadRows, type ThreadContext } from './ThreadItems.js';
import { msg } from './thread-fixtures.test-support.js';
import { groupThread, type ThreadEntry } from './thread-model.js';
import type { LeaderThreadMessage } from './thread-types.js';

afterEach(cleanup);

const ctx: ThreadContext = {
  leader: null,
  actions: { act: vi.fn(), busy: false, error: null, clearError: vi.fn(), readOnly: false, dialogs: null },
  answered: new Map(), byId: new Map(), answering: new Set(), focusQuestionId: null,
  answerDraft: () => '', setAnswerDraft: vi.fn(), onAnswer: vi.fn(), onRetry: vi.fn(), onDiscard: vi.fn(),
  sendDisabledReason: null, dormant: false,
};
function show(message: LeaderThreadMessage) {
  const entry: ThreadEntry = { type: 'message', key: message.id, at: message.at, message };
  return render(<ThreadRows rows={groupThread([entry])} ctx={ctx} />);
}

it.each([['imessage', 'iMessage'], ['email', 'Email'], ['mobile', 'Phone']] as const)('labels a %s Mason message', (channel, label) => {
  show(msg({ id: channel, from: 'mason', channel, text: 'hello' }));
  expect(screen.getByText(`via ${label}`)).toBeInTheDocument();
});

it('shows no "via" label for a verse message', () => {
  show(msg({ id: 'v', from: 'mason', channel: 'verse', text: 'hello' }));
  expect(screen.queryByText(/^via /)).toBeNull();
});
