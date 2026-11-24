// @vitest-environment jsdom
/**
 * What became of a session's pull request, as the job ledger records it
 * (`work.pr` of the read): on its Conversations card, on its row beside an
 * open conversation, and at the top of the conversation itself. A session
 * whose read holds no recorded outcome shows none: unknown is never "open".
 * Fixtures only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SessionThreadView } from '../fleet-sessions/SessionThread.js';
import { narrowSessionThread } from '../fleet-sessions/session-thread-model.js';
import { WallView } from './SessionWall.js';
import { RailVitalsLine } from './WallVitals.js';
import { narrowSessionWall, type SessionWallRead } from './session-wall-model.js';
import { cardVitals, hasVitals, prFate, summaryLeft } from './wall-vitals.js';

const AT = '2026-11-21T06:30:00.000Z';
const PR = 'https://github.com/ashlrai/phantom/pull/7836';
const MERGED = { state: 'merged', mergeSeconds: 92, at: '2026-11-21T06:26:00.000Z' } as const;
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'done', startedAt: null, ageSeconds: 1800, lastMessageAt: null, lastMessageAgeSeconds: 120, prUrl: PR,
  computer: 'unknown', helpers: { below: 0, running: 0, failed: 0 }, ...over });
/** The sentences the server writes for a finished worker whose pull request merged (session-thread.ts `summaryOf`). */
const SUMMARY = ['Worker on claude, fixture-model, in phantom.', 'Done; spoke 2m ago.', `Pull request: ${PR}`, '0 commands seen, changed files unknown.',
  `Latest step: outcome state=MERGED ttm_s=92 url=${PR} at 2026-11-21T06:26:00.000Z.`, 'Its pull request merged 1m after it opened.'];
const work = (pr: unknown) => ({ ...(pr === undefined ? {} : { pr }), commands: 0, files: null, step: { event: 'outcome', summary: `state=MERGED ttm_s=92 url=${PR}`, at: '2026-11-21T06:26:00.000Z' } });
const entry = (id: string, pr: unknown, over: Record<string, unknown> = {}) => ({
  session: session(id), summary: SUMMARY, messages: [], messageCount: 0, sources: {}, gaps: [], control: null,
  reply: { to: 'job', mention: `@${id}`, hint: 'Goes to the Leader\'s inbox.' }, serves: null, work: work(pr), ...over });
function wall(threads: unknown[]): SessionWallRead {
  const read = narrowSessionWall({ schema: 'fleet.session-threads.v1', generatedAt: AT, filter: { lane: null, repo: null, live: false }, counts: { sessions: threads.length }, threads, gaps: [] });
  if (!read) throw new Error('fixture is not a session-threads read');
  return read;
}
const card = (id: string) => screen.getByRole('button', { name: new RegExp(`^${id}, `) });
const chip = (id: string) => card(id).querySelector<HTMLElement>('[data-vital="pr"]');

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the outcome of a pull request, worded', () => {
  it('says merged with how long it took, closed, and still open with how long ago that was checked', () => {
    expect(prFate(MERGED, AT)).toEqual({ state: 'merged', words: 'merged in 1m', short: 'merged', title: 'Pull request merged 1m after it opened, recorded 4m ago' });
    expect(prFate({ state: 'merged', mergeSeconds: null, at: null }, AT)).toEqual({ state: 'merged', words: 'merged', short: 'merged',
      title: 'Pull request merged; how long after it opened is not recorded, time of the record unknown' });
    expect(prFate({ state: 'closed', mergeSeconds: null, at: '2026-11-21T04:30:00.000Z' }, AT)).toEqual({ state: 'closed', words: 'closed, not merged', short: 'closed',
      title: 'Pull request closed without merging, recorded 2h 0m ago' });
    expect(prFate({ state: 'open', mergeSeconds: null, at: '2026-11-21T06:18:00.000Z' }, AT)).toEqual({ state: 'open', words: 'still open 12m ago', short: 'open',
      title: 'Pull request still open when last checked, 12m ago' });
    // A check with no usable time is still a check; it does not get an age.
    expect(prFate({ state: 'open', mergeSeconds: null, at: null }, AT)).toMatchObject({ words: 'still open', title: 'Pull request still open when last checked, time unknown' });
    expect([prFate(null, AT), prFate(undefined, AT)]).toEqual([null, null]);
  });

  it('is a vital of its own, and the sentence that states it steps aside', () => {
    const vitals = cardVitals({ work: { pr: MERGED, commands: null, files: null, step: null }, session: { helpers: null, prUrl: null } }, AT);
    expect(vitals.fate?.words).toBe('merged in 1m');
    expect(hasVitals({ ...vitals, commands: null, diff: null })).toBe(true);
    expect(summaryLeft(['Done; spoke 2m ago.', 'Its pull request merged 1m after it opened.'], vitals)).toEqual(['Done; spoke 2m ago.']);
    // With no outcome on the read, a sentence about it (from a newer server) is kept.
    const none = cardVitals({ work: { commands: null, files: null, step: null }, session: { helpers: null, prUrl: null } }, AT);
    expect(none.fate).toBeNull();
    expect(summaryLeft(['Its pull request merged.'], none)).toEqual(['Its pull request merged.']);
  });
});

describe('the read', () => {
  it('believes only a state it knows, and a merge time only on a merge', () => {
    const read = (pr: unknown) => wall([entry('RQ-A', pr)]).entries[0]!.work;
    expect(read(MERGED)?.pr).toEqual(MERGED);
    expect(read({ state: 'open', mergeSeconds: 40, at: 'yesterday' })?.pr).toEqual({ state: 'open', mergeSeconds: null, at: null });
    expect(read({ state: 'merged', mergeSeconds: -3, at: AT })?.pr).toEqual({ state: 'merged', mergeSeconds: null, at: AT });
    expect([read(null)?.pr, read({ state: 'abandoned' })?.pr, read('merged')?.pr]).toEqual([null, null, null]);
    // A server that predates the reading sends no key, and the narrowed work holds none.
    expect('pr' in read(undefined)!).toBe(false);
  });
});

describe('a Conversations card', () => {
  it('says what became of the pull request beside the job\'s figures, once', () => {
    render(<WallView read={wall([entry('RQ-A', MERGED), entry('RQ-B', { state: 'closed', mergeSeconds: null, at: '2026-11-21T06:00:00.000Z' }),
      entry('RQ-C', { state: 'open', mergeSeconds: null, at: '2026-11-21T06:18:00.000Z' })])} onOpen={vi.fn()} />);
    expect(chip('RQ-A')).toHaveTextContent('PR merged in 1m');
    expect(chip('RQ-A')).toHaveAttribute('data-fate', 'merged');
    expect(chip('RQ-A')).toHaveAttribute('title', 'Pull request merged 1m after it opened, recorded 4m ago');
    expect(chip('RQ-B')).toHaveTextContent('PR closed, not merged');
    expect(chip('RQ-B')).toHaveAttribute('data-fate', 'closed');
    expect(chip('RQ-C')).toHaveTextContent('PR still open 12m ago');
    expect(chip('RQ-C')).toHaveAttribute('data-fate', 'open');
    // The mark is decoration: the words carry the outcome.
    expect(chip('RQ-A')!.querySelector('i')).toHaveAttribute('aria-hidden', 'true');
    // The sentence the chip states is not repeated; the link to the pull request is still beside the card.
    expect(card('RQ-A').textContent).not.toContain('Its pull request merged');
    expect(card('RQ-A').textContent).toContain('Done; spoke 2m ago.');
    expect(screen.getByRole('link', { name: 'Pull request #7836 for RQ-A' })).toHaveAttribute('href', PR);
    // The chip is part of what the card says about itself.
    const described = card('RQ-A').getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)!);
    expect(described.some(node => node.contains(chip('RQ-A')))).toBe(true);
  });

  it('shows no outcome when none is recorded, and keeps the summary whole', () => {
    render(<WallView read={wall([entry('RQ-A', null, { summary: SUMMARY.slice(0, 5) }), entry('RQ-OLD', undefined)])} onOpen={vi.fn()} />);
    expect(chip('RQ-A')).toBeNull();
    expect(card('RQ-A').textContent).not.toMatch(/still open|merged in|not merged/);
    // An older server's read has no `pr`; a newer summary sentence is then the only place the outcome is said, so it stays.
    expect(chip('RQ-OLD')).toBeNull();
    expect(card('RQ-OLD').textContent).toContain('Its pull request merged 1m after it opened.');
  });
});

describe('a row beside an open conversation', () => {
  it('names the outcome in one word, and leaves it out when none is recorded', () => {
    const { container, rerender } = render(<RailVitalsLine vitals={cardVitals({ work: { pr: MERGED, commands: null, files: null, step: null }, session: { helpers: null, prUrl: PR } }, AT)} />);
    const line = () => container.querySelector<HTMLElement>('[data-vitals] [data-vital="pr"]');
    expect(line()).toHaveTextContent(/^merged$/);
    expect(line()).toHaveAttribute('data-fate', 'merged');
    expect(line()).toHaveAttribute('title', 'Pull request merged 1m after it opened, recorded 4m ago');
    rerender(<RailVitalsLine vitals={cardVitals({ work: { pr: null, commands: null, files: null, step: null }, session: { helpers: null, prUrl: PR } }, AT)} />);
    expect(container.querySelector('[data-vitals]')).not.toBeNull();
    expect(line()).toBeNull();
  });
});

describe('the top of an opened conversation', () => {
  const thread = (pr: unknown) => narrowSessionThread({ schema: 'fleet.session-thread.v1', generatedAt: AT, id: 'RQ-A', session: session('RQ-A'), summary: SUMMARY, messages: [],
    sources: { sessions: 'available', activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none' }, gaps: [], work: work(pr) })!;
  const reading = () => screen.getByLabelText('Summary').querySelector<HTMLElement>('[data-reading="pr"] dd');

  it('has a Pull request reading with the outcome, and leaves its sentence out of the summary below', () => {
    render(<SessionThreadView thread={thread(MERGED)} sent={[]} onSent={vi.fn()} />);
    expect(reading()).toHaveTextContent('Merged in 1m');
    expect(reading()).toHaveAttribute('data-fate', 'merged');
    expect(reading()).toHaveAttribute('title', 'Pull request merged 1m after it opened, recorded 4m ago');
    expect(reading()!.previousElementSibling).toHaveTextContent('Pull request');
    expect(screen.getByLabelText('Summary').textContent).not.toContain('Its pull request merged');
  });

  it('has no such reading when the read records no outcome', () => {
    render(<SessionThreadView thread={thread(null)} sent={[]} onSent={vi.fn()} />);
    expect(reading()).toBeNull();
    expect(screen.getByLabelText('Summary').querySelector('[data-reading="step"]')).not.toBeNull();
  });
});
