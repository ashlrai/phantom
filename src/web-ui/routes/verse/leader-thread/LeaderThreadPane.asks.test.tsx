import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { buildAskBatch } from '../../../../core/fleet/asks-batch.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import type { LeaderQuestionProjection, LeaderThreadMessage } from '../leader/thread-types.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const threadPath = '/api/verse/leader/thread';
const questionsPath = '/api/verse/leader/questions';
const revision = Array(8).fill('a'.repeat(8)).join('-');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

/** A Leader question with two choices, as the thread and the exact read both carry it. */
function typedQuestion(): { message: LeaderThreadMessage; projection: LeaderQuestionProjection } {
  const form = { schemaVersion: 1 as const, revision, mode: 'single' as const, options: ['Ship it now', 'Hold for CI'], expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  const askedAt = minutesAgo(14);
  return {
    message: msg({ id: 'q-typed', at: askedAt, kind: 'question', questionId: 'memo-7:0', text: 'Ship the release tonight?', questionForm: form }),
    projection: { questionId: 'memo-7:0', text: 'Ship the release tonight?', askedAt, messageId: 'q-typed', answered: false, answer: null, questionForm: form },
  };
}

function serve(options: { messages: () => LeaderThreadMessage[]; question?: () => LeaderQuestionProjection; post?: (url: string, body: Record<string, unknown>) => Response | undefined }) {
  return stubSurfaceFetch({ routes: {
    [threadPath]: () => json({ messages: options.messages() }),
    [questionsPath]: () => options.question ? json({ question: options.question(), typedQuestionsSupported: true }) : json({ error: 'not found' }, 404),
    '/api/verse/leader/directives': { directives: [] },
  }, post: options.post });
}

const tray = () => screen.findByRole('region', { name: 'The Leader is asking' });

describe('Leader thread pane, the ask ledger at the top', () => {
  it('shows Needs you with one-tap buttons above the overview, and answers through the typed route', async () => {
    const batch = buildAskBatch([
      { id: 'nm-a', question: 'Use the Claude API credit before Nov 24?', kind: 'yes-no', askedAt: minutesAgo(30), hardLimit: 'money' },
      { id: 'nm-b', question: 'What percent of your Grok plan is used?', kind: 'short-value', numeric: true, askedAt: minutesAgo(60), hardLimit: null },
    ]);
    let answered: Record<string, unknown> | null = null;
    serve({
      messages: () => [msg({ id: 'one', text: 'Hello from the Leader.' })],
      post: (url, body) => {
        if (!url.endsWith('/needs-mason/asks/answer')) return undefined;
        answered = body;
        return json({ schema: 'asks.answer.v1', status: 'answered', answer: body.answer });
      },
    });
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/needs-mason/asks/batch') ? Promise.resolve(json(batch)) : base(input, init));
    render(<LeaderThreadPane visible />);
    const heading = await screen.findByText('Asks (2)');
    expect(heading.compareDocumentPosition(screen.getByRole('region', { name: 'Leader overview' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: /What percent of your Grok plan/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Yes: Use the Claude API credit/ }));
    expect(await screen.findByText('Recorded: yes.')).toBeInTheDocument();
    expect(answered).toEqual({ id: 'nm-a', answer: 'yes' });
  });
});

describe('Leader thread pane, the Leader is asking', () => {
  it('shows nothing when the Leader has asked nothing, and keeps the reply box', async () => {
    serve({ messages: () => [msg({ id: 'one', text: 'Hello from the Leader.' })] });
    render(<LeaderThreadPane visible />);
    await screen.findByText('Hello from the Leader.');
    expect(screen.queryByRole('region', { name: 'The Leader is asking' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Reply to the Leader' })).toBeEnabled();
  });

  it('does not call the filtered view all clear while a question is open', async () => {
    const q = typedQuestion();
    let messages = [q.message];
    serve({ messages: () => messages, question: () => q.projection });
    const view = render(<LeaderThreadPane visible />);
    await tray();
    fireEvent.click(screen.getByRole('button', { name: 'Needs you only' }));
    expect(await screen.findByText('The Leader is asking you a question, below.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing needs you right now.')).toBeNull();
    expect(screen.getByRole('region', { name: 'The Leader is asking' })).toBeInTheDocument();
    view.unmount();

    evictAll();
    messages = [msg({ id: 'one', text: 'Hello from the Leader.' })];
    render(<LeaderThreadPane visible />);
    await screen.findByText('Hello from the Leader.');
    fireEvent.click(screen.getByRole('button', { name: 'Needs you only' }));
    expect(await screen.findByText('Nothing needs you right now.')).toBeInTheDocument();
  });

  it('answers a question with choices from the keyboard and clears it once the thread has the answer', async () => {
    const q = typedQuestion();
    let messages = [q.message];
    let current = q.projection;
    const net = serve({ messages: () => messages, question: () => current, post: url => {
      if (!url.startsWith(questionsPath)) return undefined;
      const at = new Date().toISOString();
      current = { ...q.projection, answered: true, answer: { text: 'Hold for CI', at, channel: 'verse', messageId: 'a-1',
        typedAcceptance: { schemaVersion: 1, formRevision: revision, kind: 'options', optionIndices: [1], text: 'Hold for CI', at, messageId: 'a-1' } } };
      messages = [q.message, msg({ id: 'a-1', at, from: 'mason', kind: 'answer', questionId: 'memo-7:0', text: 'Hold for CI' })];
      return json({ outcome: 'recorded', question: current, message: null, reply: null });
    } });
    render(<LeaderThreadPane visible />);
    const region = await tray();
    expect(within(region).getByText('Ship the release tonight?')).toBeInTheDocument();
    expect(within(region).getByText('asked 14m ago')).toBeInTheDocument();
    const hold = await within(region).findByRole('radio', { name: 'Hold for CI' });
    fireEvent.keyDown(within(region).getByRole('radio', { name: 'Ship it now' }), { key: '2' });
    expect(hold).toBeChecked();
    expect(net.posted).toHaveLength(0);
    fireEvent.keyDown(hold, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(net.posted).toEqual([{ url: `${questionsPath}/memo-7:0/answer`,
      body: { submission: { schemaVersion: 1, formRevision: revision, kind: 'options', optionIndices: [1] } } }]));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'The Leader is asking' })).toBeNull());
    expect(screen.getByText('Answer sent. Nothing else is waiting on you.')).toBeInTheDocument();
  });

  it('leads with the question that has waited longest and steps to the next without losing a draft', async () => {
    // Built before the pane mounts, so the ages are measured from an earlier clock than the pane's.
    const asked = [
      msg({ id: 'q-new', at: minutesAgo(3), kind: 'question', text: 'Which repo goes first?' }),
      msg({ id: 'q-old', at: minutesAgo(125), kind: 'question', text: 'Raise the overnight budget?' }),
    ];
    serve({ messages: () => asked });
    render(<LeaderThreadPane visible />);
    const region = await tray();
    expect(within(region).getByText('1 of 2 · asked 2h 5m ago')).toBeInTheDocument();
    fireEvent.change(within(region).getByRole('textbox', { name: 'Answer the Leader' }), { target: { value: 'Not tonight' } });
    fireEvent.click(within(region).getByRole('button', { name: 'Next question' }));
    expect(within(region).getByText('2 of 2 · asked 3m ago')).toBeInTheDocument();
    expect(within(region).getByRole('textbox', { name: 'Answer the Leader' })).toHaveValue('');
    fireEvent.click(within(region).getByRole('button', { name: 'Next question' }));
    expect(within(region).getByRole('textbox', { name: 'Answer the Leader' })).toHaveValue('Not tonight');
  });

  it('sends a written answer to the question route and keeps the words when the server refuses', async () => {
    let refuse = true;
    const net = serve({ messages: () => [msg({ id: 'q-plain', at: minutesAgo(1), kind: 'question', questionId: 'memo-9:1', text: 'Anything to add?' })],
      post: url => url.startsWith(questionsPath) && refuse ? json({ error: 'The Leader is unavailable.' }, 500) : undefined });
    render(<LeaderThreadPane visible />);
    const region = await tray();
    const box = within(region).getByRole('textbox', { name: 'Answer the Leader' });
    fireEvent.change(box, { target: { value: 'Keep it small' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await within(region).findByRole('alert')).toHaveTextContent('The Leader is unavailable. Your answer is kept.');
    expect(within(region).getByRole('textbox', { name: 'Answer the Leader' })).toHaveValue('Keep it small');
    refuse = false;
    fireEvent.keyDown(within(region).getByRole('textbox', { name: 'Answer the Leader' }), { key: 'Enter' });
    await waitFor(() => expect(net.posted.at(-1)).toEqual({ url: `${questionsPath}/memo-9:1/answer`, body: { text: 'Keep it small' } }));
    expect(await within(region).findByText('Answer sent.')).toBeInTheDocument();
  });

  it('does not treat a digit typed into a written answer as a choice, and asks for the token before sending', async () => {
    clearMutationToken();
    const net = serve({ messages: () => [msg({ id: 'q-plain', at: minutesAgo(1), kind: 'question', text: 'How many lanes?' })] });
    render(<LeaderThreadPane visible />);
    const region = await tray();
    const box = within(region).getByRole('textbox', { name: 'Answer the Leader' });
    expect(fireEvent.keyDown(box, { key: '3' })).toBe(true);
    fireEvent.change(box, { target: { value: '3' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const dialog = await screen.findByRole('dialog', { name: 'Unlock actions' });
    expect(net.posted).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(region).getByRole('textbox', { name: 'Answer the Leader' })).toHaveValue('3');
  });

  it('folds away and back without dropping the question', async () => {
    serve({ messages: () => [msg({ id: 'q-plain', at: minutesAgo(1), kind: 'question', text: 'Fold me?' })] });
    render(<LeaderThreadPane visible />);
    const region = await tray();
    const toggle = within(region).getByRole('button', { name: /The Leader is asking/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(region).queryByRole('textbox', { name: 'Answer the Leader' })).toBeNull();
    fireEvent.click(toggle);
    expect(within(region).getByText('Fold me?')).toBeInTheDocument();
  });
});
