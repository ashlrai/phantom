// @vitest-environment jsdom
/**
 * What a session's job was asked to do, one line quoted from its brief (the
 * read's `task`): on its Conversations card, on its row beside an open
 * conversation, at the top of the conversation's Summary, and in what the
 * find box looks through. Fixtures only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SessionThreadView } from '../fleet-sessions/SessionThread.js';
import { narrowSessionThread, type ThreadTask } from '../fleet-sessions/session-thread-model.js';
import { SessionRail } from './SessionRail.js';
import { WallView } from './SessionWall.js';
import { findEntries, narrowSessionWall, type SessionWallRead } from './session-wall-model.js';
import { TASK_UNKNOWN, taskHint, taskName } from './WallTask.js';

const AT = '2026-11-21T12:00:00.000Z';
const TITLE = { line: 'Goal: lexicon CONTRIBUTING links the README freshness test', from: 'title', truncated: false };
const QUEUED = { line: 'The "Shipped today" card exists on Home but not on the Feed page.', from: 'queue', truncated: false };
const OPENING = { line: 'You are a senior engineer. Fix the reply box.', from: 'opening', truncated: true };
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', startedAt: null, ageSeconds: 1800, lastMessageAt: null, lastMessageAgeSeconds: 120, prUrl: null,
  computer: 'unknown', helpers: { below: 0, running: 0, failed: 0 }, ...over });
const entry = (id: string, over: Record<string, unknown> = {}, sessionOver: Record<string, unknown> = {}) => ({
  session: session(id, sessionOver), summary: ['Worker on claude, fixture-model, in phantom.'], messages: [], messageCount: 0, sources: {}, gaps: [], control: null,
  reply: { to: 'job', mention: `@${id}`, hint: 'Goes to the Leader\'s inbox.' }, serves: null, work: null, ...over });
function wall(threads: unknown[]): SessionWallRead {
  const read = narrowSessionWall({ schema: 'fleet.session-threads.v1', generatedAt: AT, filter: { lane: null, repo: null, live: false }, counts: { sessions: threads.length }, threads, gaps: [] });
  if (!read) throw new Error('fixture is not a session-threads read');
  return read;
}
const FLEET = [entry('RQ-TITLE', { task: TITLE }), entry('RQ-QUEUED', { task: QUEUED }), entry('RQ-OPENS', { task: OPENING }), entry('RQ-NONE', { task: null }), entry('RQ-OLD'),
  entry('sa-1', { task: TITLE }, { kind: 'subagent', jobId: null, parentId: 'RQ-TITLE' })];
const card = (id: string) => screen.getByRole('button', { name: new RegExp(`^${id}, `) });
const taskOf = (node: Element) => node.querySelector<HTMLElement>('[data-task]');

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('what a session\'s job was asked to do', () => {
  it('reads the task only as the server gives it, and only for a session with a job', () => {
    const [title, queued, opens, none, old, helper] = wall(FLEET).entries;
    expect(title!.task).toEqual(TITLE);
    expect(queued!.task).toEqual(QUEUED);
    expect(opens!.task).toEqual(OPENING);
    // Sent and empty is unknown; not sent at all is a server that does not say.
    expect(none!.task).toBeNull();
    expect('task' in old!).toBe(false);
    // A helper has no job, so a task on it is not believed.
    expect('task' in helper!).toBe(false);
    // A malformed one reads unknown, never a made-up line; its line is flattened and bounded.
    const odd = wall([entry('RQ-A', { task: { line: 42 } }), entry('RQ-B', { task: 'Fix it' }), entry('RQ-C', { task: { line: `  two\n lines ${'x'.repeat(900)}`, from: 'model' } })]).entries;
    expect([odd[0]!.task, odd[1]!.task]).toEqual([null, null]);
    // A source this build does not know claims the least: an opening line, never a title.
    expect(odd[2]!.task).toMatchObject({ from: 'opening', truncated: false });
    expect(odd[2]!.task!.line.startsWith('two lines x')).toBe(true);
    expect(odd[2]!.task!.line.length).toBeLessThanOrEqual(400);
  });

  it('sets a title as the card\'s headline, an opening line as a quote, and says unknown when the read knows none', () => {
    render(<WallView read={wall(FLEET)} onOpen={vi.fn()} />);
    const title = taskOf(card('RQ-TITLE'))!;
    expect(title).toHaveAttribute('data-task', 'title');
    expect(title).toHaveTextContent(`Task${TITLE.line}`);
    expect(title).toHaveAttribute('title', 'The title of its brief. Quoted from the record, not summarised.');
    // A queue row is the task too, named as one, with its own source in the hint.
    const queued = taskOf(card('RQ-QUEUED'))!;
    expect(queued).toHaveAttribute('data-task', 'queue');
    expect(queued).toHaveTextContent(`Task${QUEUED.line}`);
    expect(queued).toHaveAttribute('title', 'The task its router queue row held. Quoted from the record, not summarised.');
    const opens = taskOf(card('RQ-OPENS'))!;
    expect(opens).toHaveAttribute('data-task', 'opening');
    expect(opens).toHaveTextContent(`Brief opens${OPENING.line}`);
    expect(opens).toHaveAttribute('title', 'The first line of its brief, which has no title, cut to fit. Quoted from the record, not summarised.');
    const none = taskOf(card('RQ-NONE'))!;
    expect(none).toHaveAttribute('data-task', 'unknown');
    expect(none).toHaveTextContent(TASK_UNKNOWN);
    // A server that sends no task, and a helper, get no line at all.
    expect(taskOf(card('RQ-OLD'))).toBeNull();
    expect(taskOf(card('sa-1'))).toBeNull();
    // The task sits right under the card's first line and is part of what the card says about itself.
    expect(card('RQ-TITLE').children[1]).toBe(title);
    expect(card('RQ-TITLE').getAttribute('aria-describedby')!.split(' ')).toContain(title.id);
    expect(card('RQ-OLD').getAttribute('aria-describedby')!.split(' ').every(id => document.getElementById(id) !== null)).toBe(true);
    expect([taskName(TITLE as ThreadTask), taskName(QUEUED as ThreadTask), taskName(OPENING as ThreadTask), taskHint(TITLE as ThreadTask).includes('cut')]).toEqual(['Task', 'Task', 'Brief opens', false]);
  });

  it('finds a session by the words of its task', () => {
    const { entries } = wall(FLEET);
    expect(findEntries(entries, 'freshness lexicon').map(found => found.session.id)).toEqual(['RQ-TITLE']);
    expect(findEntries(entries, 'senior').map(found => found.session.id)).toEqual(['RQ-OPENS']);
    expect(findEntries(entries, 'shipped feed').map(found => found.session.id)).toEqual(['RQ-QUEUED']);
    render(<WallView read={wall(FLEET)} onOpen={vi.fn()} find="nothing-holds-this" />);
    expect(screen.getByRole('status')).toHaveTextContent('It looks in each session\'s id, lane, model, repo, task, summary and newest messages');
  });

  it('names the task on each row beside an open conversation, on one line, and leaves an unknown one out', () => {
    render(<SessionRail read={wall(FLEET)} failed={false} openId="RQ-OPENS" onPick={vi.fn()} onClose={vi.fn()} />);
    const row = (id: string) => document.querySelector<HTMLElement>(`button[data-rail="${id}"]`)!;
    expect(taskOf(row('RQ-TITLE'))).toHaveTextContent(TITLE.line);
    expect(taskOf(row('RQ-TITLE'))).toHaveAttribute('data-place', 'rail');
    expect(row('RQ-TITLE').children[1]).toBe(taskOf(row('RQ-TITLE')));
    expect(taskOf(row('RQ-OPENS'))).toHaveAttribute('data-task', 'opening');
    expect([taskOf(row('RQ-NONE')), taskOf(row('RQ-OLD')), taskOf(row('sa-1'))]).toEqual([null, null, null]);
  });

  it('opens a conversation\'s Summary with the task, from the conversation\'s own read', () => {
    const thread = (task: unknown, id = 'RQ-TITLE') => narrowSessionThread({ schema: 'fleet.session-thread.v1', generatedAt: AT, id, session: session(id),
      summary: ['Worker on claude, fixture-model, in phantom.'], ...(task === undefined ? {} : { task }), messages: [], sources: {}, gaps: [], work: null,
      reply: { to: 'job', mention: `@${id}`, hint: 'Goes to the Leader\'s inbox.' }, control: null, depth: 'recent', deeper: false })!;
    const view = render(<SessionThreadView thread={thread(TITLE)} sent={[]} onSent={vi.fn()} />);
    const summary = screen.getByLabelText('Summary');
    expect(taskOf(summary)).toHaveTextContent(`Task${TITLE.line}`);
    expect(taskOf(summary)).toHaveAttribute('data-place', 'thread');
    // Above the summary's sentences, which stay.
    expect(taskOf(summary)!.compareDocumentPosition(screen.getByText('Worker on claude, fixture-model, in phantom.')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    view.rerender(<SessionThreadView thread={thread(null)} sent={[]} onSent={vi.fn()} />);
    expect(taskOf(screen.getByLabelText('Summary'))).toHaveTextContent(TASK_UNKNOWN);
    view.rerender(<SessionThreadView thread={thread(undefined)} sent={[]} onSent={vi.fn()} />);
    expect(taskOf(screen.getByLabelText('Summary'))).toBeNull();
    expect('task' in thread(undefined)).toBe(false);
  });
});
