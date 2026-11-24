// @vitest-environment jsdom
/**
 * What a session's job has done, at the top of its opened conversation and on
 * each row of the list beside it: the readings a Conversations card draws,
 * read from this conversation's own `work`, `session.helpers` and
 * `session.prUrl`. Fixtures only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { SessionRail } from '../session-wall/SessionRail.js';
import { narrowSessionWall } from '../session-wall/session-wall-model.js';
import { SessionThread, SessionThreadView } from './SessionThread.js';
import { narrowSessionThread, SESSION_THREAD_API } from './session-thread-model.js';
import { evictAll } from '../../../data/cache.js';

const AT = '2026-11-18T12:00:00.000Z';
const PR = 'https://github.com/ashlrai/phantom/pull/7791';
/** The sentences the server writes for a worker (core/fleet/session-thread.ts `summaryOf`). */
const SUMMARY = ['Worker on claude, fixture-model, in phantom.', 'Running for 30m; spoke 2m ago.', '2 of 3 helpers running, 1 failed.', `Pull request: ${PR}`,
  '1234 commands seen, 5 files changed (+120 −14).', 'Latest step: verify tests green at 2026-11-18T11:56:00.000Z.', 'Pause requested at 2026-11-18T11:58:00.000Z. The dispatcher has not applied it yet.'];
const WORK = { commands: 1234, files: { count: 5, added: 120, removed: 14, partial: false }, step: { event: 'verify', summary: 'tests green', at: '2026-11-18T11:56:00.000Z' } };
const session = (over: Record<string, unknown> = {}) => ({ id: 'RQ-A', kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: 'RQ-A', parentId: 'leader', state: 'running', startedAt: null, ageSeconds: 1800, lastMessageAt: null, lastMessageAgeSeconds: 120, prUrl: PR,
  computer: 'unknown', helpers: { below: 3, running: 2, failed: 1 }, ...over });
/** A fleet.session-thread.v1 body: `work` sits between `gaps` and `reply`. */
const wire = (over: Record<string, unknown> = {}, sessionOver: Record<string, unknown> = {}) => ({
  schema: 'fleet.session-thread.v1', generatedAt: AT, id: 'RQ-A', session: session(sessionOver), summary: SUMMARY, messages: [],
  sources: { sessions: 'available', activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none' }, gaps: [], work: WORK, ...over });
const thread = (over?: Record<string, unknown>, sessionOver?: Record<string, unknown>) => narrowSessionThread(wire(over, sessionOver))!;
const show = (over?: Record<string, unknown>, sessionOver?: Record<string, unknown>) => render(<SessionThreadView thread={thread(over, sessionOver)} sent={[]} onSent={vi.fn()} />);
const summary = () => screen.getByLabelText('Summary');
const readings = () => within(summary()).getByLabelText('What RQ-A\'s job has done');
const reading = (name: string) => summary().querySelector<HTMLElement>(`[data-reading="${name}"] dd`);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); evictAll(); });

describe('the read', () => {
  it('carries the work and the helpers, each part narrowed on its own', () => {
    expect(thread().work).toEqual(WORK);
    expect(thread().session.helpers).toEqual({ below: 3, running: 2, failed: 1 });
    // A part that is not what it should be reads unknown; the others stand.
    expect(thread({ work: { commands: '34', files: { count: 5, added: -1, removed: 14 }, step: { event: 'verify', summary: 7, at: 'yesterday' } } }).work)
      .toEqual({ commands: null, files: null, step: { event: 'verify', summary: '', at: null } });
    expect(thread({}, { helpers: { below: 3, running: 'two', failed: 0 } }).session.helpers).toBeNull();
  });

  it('holds no work from a server that sends none, or for a session with no job', () => {
    expect([thread({ work: undefined }).work, thread({ work: null }).work, thread({ work: 'lots' }).work]).toEqual([null, null, null]);
    // Work is a job's: a body cannot hang one on the leader or a helper.
    expect(thread({}, { id: 'leader', kind: 'leader', jobId: null }).work).toBeNull();
  });
});

describe('the top of an opened conversation', () => {
  it('draws the newest step with its age, the diff, the commands and the helpers', () => {
    show();
    expect(reading('step')).toHaveTextContent('verifytests green4m ago');
    expect(reading('diff')).toHaveTextContent('+120−14in 5 files');
    expect(reading('diff')).toHaveAttribute('title', '5 files changed, 120 added, 14 removed');
    expect(reading('commands')).toHaveTextContent('1,234');
    expect(reading('commands')).toHaveAttribute('title', '1234 commands seen in its log');
    expect(reading('helpers')).toHaveTextContent('2 of 3 running, 1 failed');
    expect(reading('helpers')).toHaveAttribute('data-failed');
    // Each reading is a named term, so it reads as "Latest step: …" and not as loose figures.
    expect([...readings().querySelectorAll('dt')].map(term => term.textContent)).toEqual(['Latest step', 'Changed', 'Commands', 'Helpers']);
    // The diff bar is two stretches in proportion, hidden from the accessible text.
    const parts = [...reading('diff')!.querySelectorAll<HTMLElement>('i[data-part]')];
    expect(parts.map(part => [part.dataset.part, part.style.flexGrow])).toEqual([['added', '120'], ['removed', '14']]);
    expect(reading('diff')!.querySelector('i')).toHaveAttribute('aria-hidden', 'true');
  });

  it('says each thing once: a sentence a reading states is left out, and every other sentence stays', () => {
    show();
    const said = [...summary().querySelectorAll('p')].map(line => line.textContent);
    expect(said).toEqual(['Worker on claude, fixture-model, in phantom.', 'Running for 30m; spoke 2m ago.',
      'Pause requested at 2026-11-18T11:58:00.000Z. The dispatcher has not applied it yet.']);
  });

  it('says unknown for a part the read could not measure, never 0', () => {
    show({ work: { commands: null, files: null, step: { event: 'launch', summary: '', at: null } },
      summary: ['Worker on claude, fixture-model, in phantom.', 'Commands unknown, changed files unknown.', 'Latest step: launch.'] }, { helpers: { below: 0, running: 0, failed: 0 } });
    expect(reading('step')).toHaveTextContent('launchtime unknown');
    expect(reading('diff')).toHaveTextContent('unknown');
    expect(reading('diff')).toHaveAttribute('data-unknown');
    expect(reading('commands')).toHaveTextContent('unknown');
    expect(reading('commands')).toHaveAttribute('title', 'The commands in its log could not be read');
    expect(summary().textContent).not.toMatch(/\b0\b/);
    // No helpers below it: no reading for them, rather than "0 of 0".
    expect(reading('helpers')).toBeNull();
    // The server's own "unknown" sentence steps aside too: the readings already say it.
    expect([...summary().querySelectorAll('p')].map(line => line.textContent)).toEqual(['Worker on claude, fixture-model, in phantom.']);
  });

  it('marks a change read that was cut short, and draws no bar for an empty diff', () => {
    show({ work: { ...WORK, files: { count: 1, added: 0, removed: 0, partial: true } } });
    expect(reading('diff')).toHaveTextContent('+0−0in 1 file, partial');
    expect(reading('diff')!.querySelector('i')).toBeNull();
    expect(reading('diff')).toHaveAttribute('title', '1 file changed, 0 added, 0 removed (partial: the change read was cut short)');
  });

  it('keeps the summary whole when the read holds no work', () => {
    show({ work: undefined }, { helpers: { below: 0, running: 0, failed: 0 } });
    expect(summary().querySelector('[data-thread-work]')).toBeNull();
    expect([...summary().querySelectorAll('p')].map(line => line.textContent)).toEqual(SUMMARY);
    cleanup();
    show({ work: undefined, summary: [] }, { helpers: null });
    expect(screen.getByText('Summary unknown: the read returned none.')).toBeTruthy();
  });

  it('leaves the pull request to the link in the header, which the opened conversation always has beside it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost');
      return new Response(JSON.stringify(url.pathname === SESSION_THREAD_API ? wire() : {}), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    render(<SessionThread id="RQ-A" visible onBack={vi.fn()} />);
    expect(await screen.findByLabelText('What RQ-A\'s job has done')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pull request' })).toHaveAttribute('href', PR);
    expect(summary().textContent).not.toContain('Pull request:');
  });
});

describe('a row of the list beside an open conversation', () => {
  const entry = (id: string, over: Record<string, unknown> = {}, sessionOver: Record<string, unknown> = {}) => ({
    session: session({ id, jobId: id, prUrl: null, helpers: { below: 0, running: 0, failed: 0 }, ...sessionOver }), summary: [], messages: [], messageCount: 0, sources: {}, gaps: [],
    control: null, reply: { to: 'job', mention: `@${id}`, hint: 'Goes to the Leader\'s inbox.' }, serves: null, work: WORK, ...over });
  const wall = (threads: unknown[]) => narrowSessionWall({ schema: 'fleet.session-threads.v1', generatedAt: AT, filter: { lane: null, repo: null, live: false }, counts: { sessions: threads.length }, threads, gaps: [] })!;
  const row = (id: string) => screen.getAllByRole('button').find(button => button.dataset.rail === id)!;
  const vital = (id: string, name: string) => row(id).querySelector<HTMLElement>(`[data-vital="${name}"]`);

  it('shows the size of the diff and the newest step with its age, on one line', () => {
    render(<SessionRail read={wall([entry('RQ-A'), entry('RQ-B', { work: null }), entry('helper', { work: WORK }, { kind: 'subagent', jobId: null })])} failed={false} openId="RQ-B" onPick={vi.fn()} onClose={vi.fn()} />);
    expect(vital('RQ-A', 'diff')).toHaveTextContent('+120 −14');
    expect(vital('RQ-A', 'diff')).toHaveAttribute('title', '5 files changed, 120 added, 14 removed');
    expect(vital('RQ-A', 'step')).toHaveTextContent('verify 4m ago');
    expect(vital('RQ-A', 'step')).toHaveAttribute('title', 'Latest recorded step: verify tests green, 4m ago');
    // A session whose work was not read, and one with no job, get no line at all.
    expect(row('RQ-B').querySelector('[data-vitals]')).toBeNull();
    expect(row('helper').querySelector('[data-vitals]')).toBeNull();
  });

  it('names failed helpers, and says unknown where the change read did not answer', () => {
    render(<SessionRail read={wall([entry('RQ-A', { work: { commands: 3, files: null, step: null } }, { helpers: { below: 4, running: 1, failed: 2 } }),
      entry('RQ-B', {}, { helpers: { below: 2, running: 2, failed: 0 } })])} failed={false} openId="RQ-A" onPick={vi.fn()} onClose={vi.fn()} />);
    expect(vital('RQ-A', 'diff')).toHaveTextContent('changes unknown');
    expect(vital('RQ-A', 'helpers')).toHaveTextContent('2 helpers failed');
    expect(vital('RQ-A', 'step')).toBeNull();
    // Helpers that are all well are not news on a one-line row.
    expect(vital('RQ-B', 'helpers')).toBeNull();
  });
});
