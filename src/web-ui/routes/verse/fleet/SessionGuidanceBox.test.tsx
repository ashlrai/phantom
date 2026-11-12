/**
 * SessionGuidanceBox — the per-session guidance composer on the Working card:
 * the strategy line names how a message reaches the running agent, the box is
 * locked until controls are unlocked, a send posts {text} under the mutation
 * token, and the ack line shows queued / delivered at turn N / requeued.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { SessionGuidanceBox } from './SessionGuidanceBox.js';
import { narrowGuidanceList, guidanceForJob, ackLabel } from './session-guidance-model.js';
import type { GuidanceSessionSummary } from './session-guidance-model.js';

const TOKEN = 'd'.repeat(64);
const JOB = 'RQ-PHX-SESSION-1';

const summary = (over: Partial<GuidanceSessionSummary> = {}): GuidanceSessionSummary => ({
  job: JOB, lane: 'claude', strategy: 'resume-followup', pending: 1,
  latest: { id: 'g-1', at: '2026-11-03T19:31:00Z', state: 'queued', turn: null, requeueTo: null },
  ...over,
});

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

function stubFetch(responder: (url: string, init?: RequestInit) => Response) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => responder(String(input), init));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('SessionGuidanceBox', () => {
  it('names the lane delivery strategy and mechanism', () => {
    render(<SessionGuidanceBox job={JOB} lane="agy" summary={null} />);
    expect(screen.getByText(/stream inject/)).toBeInTheDocument();
    expect(screen.getByText(/next NDJSON user message/)).toBeInTheDocument();
    render(<SessionGuidanceBox job={JOB} lane="never-heard-of" summary={null} />);
    expect(screen.getByText(/stop at the next safe point/)).toBeInTheDocument();
  });

  it('keeps the box locked without a mutation token', () => {
    render(<SessionGuidanceBox job={JOB} lane="claude" summary={null} />);
    expect(screen.getByText('Unlock controls to send guidance.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send guidance' })).toBeDisabled();
  });

  it('posts {text} under the mutation token and shows the queued note', async () => {
    setMutationToken(TOKEN);
    const fetcher = stubFetch((url, init) => {
      if (init?.method === 'POST') {
        expect(url).toBe(`/api/fleet/sessions/${JOB}/guidance`);
        expect(init.headers).toMatchObject({ 'x-ashlr-token': TOKEN, 'Content-Type': 'application/json' });
        expect(JSON.parse(String(init.body))).toEqual({ text: 'prefer the helper' });
        return Response.json({ v: 1, ok: true, job: JOB, id: 'g-9', at: 'x', strategy: 'resume-followup', state: 'queued', truncated: false }, { status: 201 });
      }
      return Response.json({ v: 1, generatedAt: 'x', sourceState: 'healthy', sessions: [] });
    });
    render(<SessionGuidanceBox job={JOB} lane="claude" summary={null} />);
    fireEvent.change(screen.getByLabelText(`Guidance for ${JOB}`), { target: { value: 'prefer the helper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send guidance' }));
    await screen.findByText('Queued');
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === `/api/fleet/sessions/${JOB}/guidance` && init?.method === 'POST')).toBe(true);
  });

  it('sends on Cmd+Enter and reports a trimmed message', async () => {
    setMutationToken(TOKEN);
    stubFetch((_url, init) => init?.method === 'POST'
      ? Response.json({ v: 1, ok: true, job: JOB, id: 'g-9', at: 'x', strategy: 'requeue', state: 'queued', truncated: true }, { status: 201 })
      : Response.json({ v: 1, generatedAt: 'x', sourceState: 'healthy', sessions: [] }));
    render(<SessionGuidanceBox job={JOB} lane="devin" summary={null} />);
    const box = screen.getByLabelText(`Guidance for ${JOB}`);
    fireEvent.change(box, { target: { value: 'note' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await screen.findByText('Queued (trimmed to 4 KB)');
  });

  it('shows the server detail when the send fails', async () => {
    setMutationToken(TOKEN);
    stubFetch(() => Response.json({ error: 'the guidance file could not be written' }, { status: 503 }));
    render(<SessionGuidanceBox job={JOB} lane="claude" summary={null} />);
    fireEvent.change(screen.getByLabelText(`Guidance for ${JOB}`), { target: { value: 'note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send guidance' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/could not be written|503|unavailable/i));
  });

  it.each([
    ['queued', 'Queued'],
    ['delivered', 'Delivered at turn 4'],
    ['requeued', 'Requeued as RQ-PHX-SESSION-2'],
  ] as const)('shows the %s ack line', (state, label) => {
    const latest = { id: 'g-1', at: 'x', state: state as 'queued', turn: state === 'delivered' ? 4 : null, requeueTo: state === 'requeued' ? 'RQ-PHX-SESSION-2' : null };
    render(<SessionGuidanceBox job={JOB} lane="claude" summary={summary({ latest })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('narrowGuidanceList', () => {
  it('keeps well-shaped sessions and skips junk', () => {
    const narrowed = narrowGuidanceList({
      v: 1, generatedAt: 'x', sourceState: 'healthy',
      sessions: [
        { job: JOB, lane: 'agy', strategy: 'stream-json-inject', pending: 2, latest: { id: 'g-1', at: 'x', state: 'delivered', turn: 3, requeueTo: null } },
        { job: 'RQ-2', lane: null, strategy: 'surprise-kind', pending: -1, latest: 'junk' },
        'junk', { nope: true },
      ],
    });
    expect(narrowed?.sessions).toHaveLength(2);
    expect(narrowed?.sessions[0]).toMatchObject({ job: JOB, strategy: 'stream-json-inject', pending: 2, latest: { state: 'delivered', turn: 3 } });
    expect(narrowed?.sessions[1]).toMatchObject({ job: 'RQ-2', strategy: 'requeue', pending: null, latest: null });
    expect(guidanceForJob(narrowed!.sessions, JOB)?.strategy).toBe('stream-json-inject');
    expect(guidanceForJob(narrowed!.sessions, 'none')).toBeNull();
  });

  it('answers null for a non-contract answer (route not in build)', () => {
    expect(narrowGuidanceList(null)).toBeNull();
    expect(narrowGuidanceList({ v: 2 })).toBeNull();
    expect(narrowGuidanceList({ error: 'not found' })).toBeNull();
  });

  it('ackLabel covers every state', () => {
    expect(ackLabel(null)).toBe('');
    expect(ackLabel({ id: 'g', at: 'x', state: 'queued', turn: null, requeueTo: null })).toBe('Queued');
    expect(ackLabel({ id: 'g', at: 'x', state: 'delivered', turn: 9, requeueTo: null })).toBe('Delivered at turn 9');
    expect(ackLabel({ id: 'g', at: 'x', state: 'delivered', turn: null, requeueTo: null })).toBe('Delivered');
    expect(ackLabel({ id: 'g', at: 'x', state: 'requeued', turn: null, requeueTo: 'RQ-9' })).toBe('Requeued as RQ-9');
    expect(ackLabel({ id: 'g', at: 'x', state: 'requeued', turn: null, requeueTo: null })).toBe('Requeued');
  });
});
