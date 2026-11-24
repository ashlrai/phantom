// @vitest-environment jsdom
/**
 * A Conversations card's vitals: the newest recorded step and its age, the
 * diff, the commands seen, the helpers and the pull request link, drawn from
 * the read's `work`, `session.helpers` and `session.prUrl`. Fixtures only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { WallView } from './SessionWall.js';
import { narrowSessionWall, type SessionWallRead } from './session-wall-model.js';
import { cardVitals, commandsWords, diffWords, hasVitals, helpersWords, summaryLeft } from './wall-vitals.js';

const AT = '2026-11-18T12:00:00.000Z';
const PR = 'https://github.com/ashlrai/phantom/pull/7791';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', startedAt: null, ageSeconds: 1800, lastMessageAt: null, lastMessageAgeSeconds: 120, prUrl: null,
  computer: 'unknown', helpers: { below: 0, running: 0, failed: 0 }, ...over });
/** The sentences the server writes for a worker (session-thread.ts `summaryOf`). */
const SUMMARY = ['Worker on claude, fixture-model, in phantom.', 'Running for 30m; spoke 2m ago.', '2 of 3 helpers running, 1 failed.', `Pull request: ${PR}`,
  '34 commands seen, 5 files changed (+120 −14).', 'Latest step: verify tests green at 2026-11-18T11:56:00.000Z.'];
const WORK = { commands: 34, files: { count: 5, added: 120, removed: 14, partial: false }, step: { event: 'verify', summary: 'tests green', at: '2026-11-18T11:56:00.000Z' } };
const entry = (id: string, over: Record<string, unknown> = {}, sessionOver: Record<string, unknown> = {}) => ({
  session: session(id, sessionOver), summary: SUMMARY, messages: [], messageCount: 0, sources: {}, gaps: [], control: null,
  reply: { to: 'job', mention: `@${id}`, hint: 'Goes to the Leader\'s inbox.' }, serves: null, work: WORK, ...over });
function wall(threads: unknown[]): SessionWallRead {
  const read = narrowSessionWall({ schema: 'fleet.session-threads.v1', generatedAt: AT, filter: { lane: null, repo: null, live: false }, counts: { sessions: threads.length }, threads, gaps: [] });
  if (!read) throw new Error('fixture is not a session-threads read');
  return read;
}
const show = (threads: unknown[]) => render(<WallView read={wall(threads)} onOpen={vi.fn()} />);
const card = (id: string) => screen.getByRole('button', { name: new RegExp(`^${id}, `) });
const vital = (id: string, name: string) => card(id).querySelector<HTMLElement>(`[data-vital="${name}"]`);

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('a card\'s vitals on the Conversations wall', () => {
  it('draws the newest step with its age, the diff, the commands and the helpers, and says each once', () => {
    show([entry('RQ-A', {}, { helpers: { below: 3, running: 2, failed: 1 }, prUrl: PR })]);
    expect(vital('RQ-A', 'step')).toHaveTextContent('verifytests green4m ago');
    expect(vital('RQ-A', 'diff')).toHaveTextContent('+120 −14 in 5 files');
    expect(vital('RQ-A', 'diff')).toHaveAttribute('title', '5 files changed, 120 added, 14 removed');
    expect(vital('RQ-A', 'commands')).toHaveTextContent('34 commands');
    expect(vital('RQ-A', 'helpers')).toHaveTextContent('2 of 3 helpers running, 1 failed');
    expect(vital('RQ-A', 'helpers')).toHaveAttribute('data-failed');
    // The diff bar is two stretches in proportion, hidden from the accessible text.
    const parts = [...vital('RQ-A', 'diff')!.querySelectorAll<HTMLElement>('i[data-part]')];
    expect(parts.map(part => [part.dataset.part, part.style.flexGrow])).toEqual([['added', '120'], ['removed', '14']]);
    // The sentences the vitals state are not repeated in the summary; the others stay.
    const text = card('RQ-A').textContent!;
    expect(text).toContain('Worker on claude, fixture-model, in phantom. Running for 30m; spoke 2m ago.');
    for (const gone of ['Latest step:', 'commands seen', 'Pull request:', 'helpers running, 1 failed.']) expect(text).not.toContain(gone);
    // The vitals are part of what the card says about itself.
    const described = card('RQ-A').getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)!);
    expect(described.some(node => node.hasAttribute('data-vitals'))).toBe(true);
  });

  it('links the pull request beside the card, not inside its button', () => {
    const onOpen = vi.fn();
    render(<WallView read={wall([entry('RQ-A', {}, { prUrl: PR }), entry('RQ-B')])} onOpen={onOpen} />);
    const link = screen.getByRole('link', { name: 'Pull request #7791 for RQ-A' });
    expect(link).toHaveAttribute('href', PR);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('PR #7791');
    expect(card('RQ-A').contains(link)).toBe(false);
    expect(card('RQ-A').closest('li')).toContainElement(link);
    expect(card('RQ-A').closest('li')).toHaveAttribute('data-pr');
    expect(card('RQ-B').closest('li')).not.toHaveAttribute('data-pr');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    fireEvent.click(link);
    expect(onOpen).not.toHaveBeenCalled();
    // The cards are still the only things the arrow keys walk.
    card('RQ-A').focus();
    fireEvent.keyDown(card('RQ-A'), { key: 'ArrowDown' });
    expect(card('RQ-B')).toHaveFocus();
  });

  it('says unknown for a part the read could not measure, never zero', () => {
    show([
      entry('RQ-A', { work: { commands: null, files: null, step: { event: 'launch', summary: '', at: null } } }),
      entry('RQ-B', { work: { commands: 0, files: { count: 0, added: 0, removed: 0, partial: true }, step: null } }),
    ]);
    expect(vital('RQ-A', 'commands')).toHaveTextContent('commands unknown');
    expect(vital('RQ-A', 'commands')).toHaveAttribute('data-unknown');
    expect(vital('RQ-A', 'diff')).toHaveTextContent('changed files unknown');
    expect(vital('RQ-A', 'step')).toHaveTextContent('launchtime unknown');
    // A measured zero is a zero, with no bar to draw, and a partial read says so.
    expect(vital('RQ-B', 'commands')).toHaveTextContent('0 commands');
    expect(vital('RQ-B', 'diff')).toHaveTextContent('+0 −0 in 0 files, partial');
    expect(vital('RQ-B', 'diff')!.querySelector('i')).toBeNull();
    expect(vital('RQ-B', 'step')).toBeNull();
  });

  it('draws nothing, and keeps the summary whole, for a session with no work read', () => {
    show([
      entry('RQ-OLD', { work: undefined }),
      entry('leader', { work: WORK, reply: { to: 'leader', mention: null, hint: 'To the Leader.' } }, { kind: 'leader', jobId: null, parentId: null }),
      entry('helper-a', { work: null, summary: [] }, { kind: 'subagent', jobId: null, parentId: 'RQ-OLD' }),
    ]);
    for (const id of ['RQ-OLD', 'leader', 'helper-a']) expect(card(id).querySelector('[data-vitals]')).toBeNull();
    // From a server that sends no `work`, every sentence is still on the card.
    expect(card('RQ-OLD')).toHaveTextContent('34 commands seen, 5 files changed (+120 −14). Latest step: verify tests green');
    // Work is a job's: it is not believed on a session without one.
    expect(card('leader')).toHaveTextContent('Latest step: verify tests green');
    expect(within(card('helper-a')).getByText('Summary unknown: the read returned none.')).toBeInTheDocument();
  });
});

describe('wall-vitals', () => {
  const read = (over: Record<string, unknown> = {}, sessionOver: Record<string, unknown> = {}) => wall([entry('RQ-A', over, sessionOver)]).entries[0]!;

  it('measures a step\'s age against the read\'s own time', () => {
    expect(cardVitals(read(), AT).step).toEqual({ event: 'verify', summary: 'tests green', ago: '4m' });
    expect(cardVitals(read(), '2026-11-18T13:30:00.000Z').step?.ago).toBe('1h 34m');
    // A step dated after the read, or a read with no usable time, has no age.
    expect(cardVitals(read(), '2026-11-18T11:00:00.000Z').step?.ago).toBeNull();
    expect(cardVitals(read(), 'never').step?.ago).toBeNull();
  });

  it('narrows each part of work on its own', () => {
    const odd = read({ work: { commands: -1, files: { count: 2, added: 'many', removed: 0 }, step: { event: '', summary: 'x', at: AT } } });
    expect(odd.work).toEqual({ commands: null, files: null, step: null });
    expect(read({ work: 'none' }).work).toBeNull();
    expect(read({}, { helpers: { below: 2, running: 'one', failed: 0 } }).session.helpers).toBeNull();
    expect(read({}, { helpers: undefined }).session.helpers).toBeNull();
  });

  it('reads a pull request number only from a pull request address', () => {
    expect(cardVitals(read({}, { prUrl: PR }), AT).pr).toEqual({ url: PR, number: '7791' });
    expect(cardVitals(read({}, { prUrl: 'https://example.com/pull/1' }), AT).pr).toBeNull();
    expect(cardVitals(read(), AT).pr).toBeNull();
  });

  it('leaves out only the sentences whose value is drawn', () => {
    const all = cardVitals(read({}, { prUrl: PR, helpers: { below: 3, running: 2, failed: 1 } }), AT);
    expect(summaryLeft(SUMMARY, all)).toEqual(SUMMARY.slice(0, 2));
    const none = cardVitals(read({ work: null }), AT);
    expect(hasVitals(none)).toBe(false);
    expect(summaryLeft(SUMMARY, none)).toEqual(SUMMARY);
    // No step recorded: the step sentence, if the server wrote one, stays.
    expect(summaryLeft(SUMMARY, cardVitals(read({ work: { ...WORK, step: null } }), AT))).toContain(SUMMARY[5]);
    expect(summaryLeft(['Commands unknown, changed files unknown.', 'A sentence of another kind.'], cardVitals(read(), AT))).toEqual(['A sentence of another kind.']);
  });

  it('puts each figure in words', () => {
    expect(diffWords({ files: 1, added: 2, removed: 0, partial: true })).toBe('1 file changed, 2 added, 0 removed (partial: the change read was cut short)');
    expect(diffWords('unknown')).toBe('Changed files unknown');
    expect([commandsWords(1), commandsWords('unknown')]).toEqual(['1 command', 'commands unknown']);
    expect(helpersWords({ below: 1, running: 1, failed: 0 })).toBe('1 of 1 helper running');
  });
});
