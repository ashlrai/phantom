import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LIVE_SESSIONS_API } from '../fleet-sessions/sessions-model.js';
import { ENDED_OPEN_KEY } from './LeaderEnded.js';
import { LeaderRoster } from './LeaderRoster.js';
import { endedCounts, endedRows, endedShown, foldedFailureWords, outcomeWords } from './leader-ended-model.js';
import { rosterEmpty, rosterEndedFleet, rosterFleet } from './leader-roster.test-support.js';

beforeEach(() => { evictAll(); window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ended sessions, from the session list', () => {
  it('lists the failed one first, then the most recently ended, and an unknown end time last', () => {
    const rows = endedRows(rosterEndedFleet());
    expect(rows.map(row => [row.id, row.when, outcomeWords(row)])).toEqual([
      ['RQ-FAILED', 'failed 5m ago', null],
      ['RQ-EMPTY', 'finished 3m ago', 'Ended with no change'],
      ['RQ-MERGED', 'finished 12m ago', 'Opened a pull request'],
      ['helper-done', 'finished, time unknown', 'Outcome unknown'],
    ]);
    expect(rows[3]).toMatchObject({ kind: 'subagent', job: null, session: 'helper-done', outcome: null });
    expect(rows[0]).toMatchObject({ kind: 'worker', job: 'RQ-FAILED', lane: 'claude', state: 'failed' });
  });

  it('counts each side, and folds to the failed ones only', () => {
    const rows = endedRows(rosterEndedFleet());
    expect(endedCounts(rows)).toBe('3 finished · 1 failed');
    expect(endedCounts(rows.filter(row => row.state === 'failed'))).toBe('1 failed');
    expect(endedShown(rows, false).map(row => row.id)).toEqual(['RQ-FAILED']);
    expect(endedShown(rows, true)).toHaveLength(4);
    expect(foldedFailureWords(rows)).toBe('1 failed in the last hour');
    expect(foldedFailureWords(rows.filter(row => row.state === 'done'))).toBeNull();
  });

  it('a list of running sessions only gives no rows, and running sessions are never among them', () => {
    expect(endedRows(rosterEndedFleet({ live: true }))).toEqual([]);
    expect(endedRows(rosterEndedFleet()).map(row => row.id)).not.toContain('RQ-A');
    expect(endedRows(rosterEmpty())).toEqual([]);
  });
});

describe('Ended in the last hour, under Working now', () => {
  function strip(sessions: unknown, onOpenThread?: (session: string) => void) {
    stubSurfaceFetch({ routes: { [LIVE_SESSIONS_API]: sessions } });
    const onOpenLog = vi.fn();
    render(<LeaderRoster visible onOpenLog={onOpenLog} onOpenSessions={vi.fn()} onOpenThread={onOpenThread} />);
    return { onOpenLog, region: screen.getByRole('region', { name: 'Working now' }) };
  }

  it('starts with the failed session listed and the finished ones counted, not listed', async () => {
    const { region } = strip(rosterEndedFleet());
    const list = await within(region).findByRole('list', { name: 'Sessions that failed in the last hour' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent('RQ-FAILED');
    expect(list).toHaveTextContent('failed 5m ago');
    expect(within(region).getByText('3 finished · 1 failed · 3 finished not listed')).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Ended in the last hour' })).toHaveAttribute('aria-expanded', 'false');
    // The running list is still only the running session.
    expect(within(within(region).getByRole('list', { name: 'Running agent sessions' })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('unfolds to every ended session with how it ended, and remembers that', async () => {
    const { region } = strip(rosterEndedFleet());
    fireEvent.click(await within(region).findByRole('button', { name: 'Ended in the last hour' }));
    const lines = within(within(region).getByRole('list', { name: 'Sessions that ended in the last hour' })).getAllByRole('listitem');
    expect(lines.map(line => line.querySelector('strong')?.textContent)).toEqual(['RQ-FAILED', 'RQ-EMPTY', 'RQ-MERGED', 'helper-done']);
    expect(lines[1]).toHaveTextContent('finished 3m ago');
    expect(lines[1]).toHaveTextContent('Ended with no change');
    expect(lines[2]).toHaveTextContent('Opened a pull request');
    expect(lines[3]).toHaveTextContent('finished, time unknown');
    expect(lines[3]).toHaveTextContent('Outcome unknown');
    expect(within(region).getByText('3 finished · 1 failed')).toBeInTheDocument();
    expect(window.localStorage.getItem(ENDED_OPEN_KEY)).toBe('1');
    cleanup();
    evictAll();
    const again = strip(rosterEndedFleet());
    expect(await within(again.region).findByRole('button', { name: 'Ended in the last hour' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('a row opens the conversation, T does too, L opens the log, and J and K move between rows', async () => {
    const onOpenThread = vi.fn();
    const { region, onOpenLog } = strip(rosterEndedFleet(), onOpenThread);
    fireEvent.click(await within(region).findByRole('button', { name: 'Ended in the last hour' }));
    const failed = within(region).getByRole('button', { name: 'Open the conversation with RQ-FAILED, failed 5m ago' });
    fireEvent.click(failed);
    expect(onOpenThread).toHaveBeenLastCalledWith('RQ-FAILED');
    const helper = within(region).getByRole('button', { name: 'Open the conversation with helper-done, finished, time unknown' });
    fireEvent.keyDown(helper, { key: 't' });
    expect(onOpenThread).toHaveBeenLastCalledWith('helper-done');
    // A helper has no job, so no log to open.
    fireEvent.keyDown(helper, { key: 'l' });
    expect(onOpenLog).not.toHaveBeenCalled();
    fireEvent.keyDown(failed, { key: 'l' });
    expect(onOpenLog).toHaveBeenLastCalledWith('RQ-FAILED');
    fireEvent.click(within(region).getByRole('button', { name: 'Open the log for RQ-MERGED' }));
    expect(onOpenLog).toHaveBeenLastCalledWith('RQ-MERGED');

    failed.focus();
    fireEvent.keyDown(failed, { key: 'k' });
    expect(document.activeElement).toBe(helper);
    fireEvent.keyDown(helper, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(failed);
    // An ended session's job is over: nothing here aims a message at it.
    expect(within(region).queryByRole('button', { name: /^Aim your next message at RQ-FAILED/ })).toBeNull();
  });

  it('without a way to show a conversation, rows are not buttons but the log still opens', async () => {
    const { region, onOpenLog } = strip(rosterEndedFleet());
    const list = await within(region).findByRole('list', { name: 'Sessions that failed in the last hour' });
    expect(within(list).queryByRole('button', { name: /^Open the conversation/ })).toBeNull();
    fireEvent.click(within(list).getByRole('button', { name: 'Open the log for RQ-FAILED' }));
    expect(onOpenLog).toHaveBeenLastCalledWith('RQ-FAILED');
  });

  it('a folded strip still says a session failed', async () => {
    const { region } = strip(rosterFleet());
    await within(region).findByRole('list', { name: 'Sessions that failed in the last hour' });
    expect(region.querySelector('[data-ended-folded]')).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Working now' }));
    expect(within(region).queryByRole('list')).toBeNull();
    expect(within(region).getByText('1 failed in the last hour')).toBeInTheDocument();
  });

  it('draws nothing when no session ended, or when the list was asked for running sessions only', async () => {
    const empty = strip(rosterEmpty());
    await within(empty.region).findByText('No agents are working right now');
    expect(within(empty.region).queryByRole('button', { name: /^Ended in/ })).toBeNull();
    cleanup();
    evictAll();
    const live = strip(rosterEndedFleet({ live: true }));
    await within(live.region).findByRole('list', { name: 'Running agent sessions' });
    expect(within(live.region).queryByRole('button', { name: /^Ended in/ })).toBeNull();
  });
});
