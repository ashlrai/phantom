// @vitest-environment jsdom
/**
 * What each session on the "Working now" strip was asked to do: the `task`
 * of the Conversations read (fleet.session-threads.v1), joined to the strip's
 * own list by session id. Fixtures only.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LIVE_SESSIONS_API } from '../fleet-sessions/sessions-model.js';
import { narrowSessionWall, SESSION_THREADS_API } from '../session-wall/session-wall-model.js';
import { LeaderRoster } from './LeaderRoster.js';
import { rosterFleet } from './leader-roster.test-support.js';
import { rosterTasks, rosterTaskWords } from './roster-task.js';

const TITLE = { line: 'Fix the flaky reply-box test', from: 'title', truncated: false };
const QUEUED = { line: 'The "Shipped today" card exists on Home but not on the Feed page.', from: 'queue', truncated: false };
const OPENING = { line: 'You are a senior engineer. Fix the reply box.', from: 'opening', truncated: true };

const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', startedAt: null, ageSeconds: 1800, lastMessageAt: null, lastMessageAgeSeconds: 120, prUrl: null,
  computer: 'unknown', helpers: { below: 0, running: 0, failed: 0 }, ...over });
const entry = (id: string, over: Record<string, unknown> = {}, sessionOver: Record<string, unknown> = {}) => ({
  session: session(id, sessionOver), summary: ['Worker on claude, fixture-model, in phantom.'], messages: [], messageCount: 0, sources: {}, gaps: [], control: null,
  reply: { to: 'job', mention: `@${id}`, hint: 'Goes to the Leader\'s inbox.' }, serves: null, work: null, ...over });
const threads = (list: unknown[]) => ({ schema: 'fleet.session-threads.v1', generatedAt: '2026-11-17T12:00:00.000Z', filter: { lane: null, repo: null, live: false },
  counts: { sessions: list.length }, threads: list, gaps: [] });

/** RQ-A has a title, RQ-PR a queue row, RQ-QUIET a read that knows no line; the helper carries one that must not be believed. */
const KNOWN = () => threads([entry('RQ-A', { task: TITLE }), entry('RQ-PR', { task: QUEUED }), entry('RQ-QUIET', { task: null }),
  entry('helper-a', { task: TITLE }, { kind: 'subagent', jobId: null, parentId: 'RQ-A' })]);

const serve = (conversations: unknown) => stubSurfaceFetch({ routes: { [LIVE_SESSIONS_API]: rosterFleet(), [SESSION_THREADS_API]: conversations } });
const asked = (net: ReturnType<typeof serve>, path: string) => net.fetchMock.mock.calls.filter(call => String(call[0]).startsWith(path)).length;
const line = (id: string) => document.querySelector<HTMLElement>(`[data-roster-row="${id}"]`)!;
const taskOf = (id: string) => line(id).querySelector<HTMLElement>('[data-roster-task]');

function roster() {
  render(<LeaderRoster visible onOpenLog={vi.fn()} onOpenSessions={vi.fn()} />);
  return screen.getByRole('region', { name: 'Working now' });
}

beforeEach(() => { evictAll(); window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the task on a Working now line', () => {
  it('keeps only what the read says: a line, a known absence, or nothing at all', () => {
    const tasks = rosterTasks(narrowSessionWall(KNOWN()));
    expect(tasks.get('RQ-A')).toEqual(TITLE);
    expect(tasks.get('RQ-QUIET')).toBeNull();
    // A helper has no job, so the read's narrowing drops a task sent for it.
    expect(tasks.has('helper-a')).toBe(false);
    // A server that sends no `task` says nothing about the session.
    expect(rosterTasks(narrowSessionWall(threads([entry('RQ-A')]))).has('RQ-A')).toBe(false);
    expect(rosterTasks(null).size).toBe(0);
    expect(rosterTasks(undefined).size).toBe(0);
    expect(rosterTaskWords(TITLE as never)).toBe('Task: Fix the flaky reply-box test');
    expect(rosterTaskWords(OPENING as never)).toBe('Brief opens: You are a senior engineer. Fix the reply box.');
  });

  it('says what each job was asked to do between when it spoke and what it said', async () => {
    serve(KNOWN());
    const strip = roster();
    await within(strip).findByText(TITLE.line);
    const task = taskOf('RQ-A')!;
    expect(task).toHaveAttribute('data-roster-task', 'title');
    expect(task.title).toBe(`Task: ${TITLE.line}\nThe title of its brief. Quoted from the record, not summarised.`);
    // After "spoke 2m ago", before the last thing it said.
    const order = [...line('RQ-A').children].map(node => node.textContent);
    expect(order.indexOf(TITLE.line)).toBe(order.indexOf('Running the tests') - 1);
    expect(order.indexOf(TITLE.line)).toBeGreaterThan(order.indexOf('RQ-A'));
    expect(taskOf('RQ-PR')).toHaveTextContent(QUEUED.line);
    expect(taskOf('RQ-PR')).toHaveAttribute('data-roster-task', 'queue');
    // The line's button is named with it, so it is read out with the job.
    expect(within(strip).getByRole('button', { name: `Aim your next message at RQ-A, spoke 2m ago. Task: ${TITLE.line}` })).toBeInTheDocument();
  });

  it('marks a brief with no title as only how it opens, and says a cut line was cut', async () => {
    serve(threads([entry('RQ-A', { task: OPENING })]));
    const strip = roster();
    await within(strip).findByText(OPENING.line);
    expect(taskOf('RQ-A')).toHaveAttribute('data-roster-task', 'opening');
    expect(taskOf('RQ-A')!.title).toBe(`Brief opens: ${OPENING.line}\nThe first line of its brief, which has no title, cut to fit. Quoted from the record, not summarised.`);
    expect(within(strip).getByRole('button', { name: `Aim your next message at RQ-A, spoke 2m ago. Brief opens: ${OPENING.line}` })).toBeInTheDocument();
  });

  it('puts nothing in place of a task the read does not know, has not said, or left out', async () => {
    serve(KNOWN());
    const strip = roster();
    await within(strip).findByText(TITLE.line);
    // Known to have no readable line, a helper, and (RQ-QUIET aside) nothing invented from an id or a last message.
    expect(taskOf('RQ-QUIET')).toBeNull();
    expect(taskOf('helper-a')).toBeNull();
    expect(line('RQ-QUIET')).toHaveTextContent('Last message unknown');
    expect(within(strip).getByRole('button', { name: 'Aim your next message at RQ-QUIET, quiet 14m' })).toBeInTheDocument();
    expect(within(strip).getAllByRole('listitem')).toHaveLength(4);
  });

  it('shows the strip as before when the Conversations read is missing, fails or is another schema', async () => {
    for (const conversations of [null, () => new Response('down', { status: 503 }), { schema: 'something.else.v1', threads: [entry('RQ-A', { task: TITLE })] }]) {
      evictAll();
      const net = serve(conversations);
      const strip = roster();
      await within(strip).findByText('Running the tests');
      await waitFor(() => expect(asked(net, SESSION_THREADS_API)).toBeGreaterThan(0));
      expect(strip.querySelector('[data-roster-task]')).toBeNull();
      expect(within(strip).getByText('4 working now · 1 quiet')).toBeInTheDocument();
      expect(within(strip).getByRole('button', { name: 'Aim your next message at RQ-A, spoke 2m ago' })).toBeInTheDocument();
      expect(net.posted).toEqual([]);
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it('asks the Conversations read the wall asks, once, and not at all while the strip is not on screen', async () => {
    const net = serve(KNOWN());
    render(<LeaderRoster visible={false} onOpenLog={vi.fn()} onOpenSessions={vi.fn()} />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(asked(net, SESSION_THREADS_API)).toBe(0);
    cleanup();
    const strip = roster();
    await within(strip).findByText(TITLE.line);
    expect(net.fetchMock.mock.calls.map(call => String(call[0])).filter(url => url.startsWith(SESSION_THREADS_API))).toEqual([SESSION_THREADS_API]);
  });
});
