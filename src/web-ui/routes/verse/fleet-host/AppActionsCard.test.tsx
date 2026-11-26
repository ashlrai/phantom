import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppActionEntry, AppActionsReport } from '../../../../core/apps-actions.js';
import { evictAll } from '../../../data/cache.js';
import { AppActionsCard } from './AppActionsCard.js';
import { actionAgo, actionLine, actionsHeadline, narrowAppActions, needsLook } from './app-actions-model.js';

const NOW = Date.parse('2026-11-19T12:10:00Z');
const entry = (minutesAgo: number, action: string, app: string, outcome: string, detail: string | null = null): AppActionEntry => ({
  key: `${minutesAgo}-${app}`, at: new Date(NOW - minutesAgo * 60_000).toISOString(), action, app, outcome, detail } as AppActionEntry);
const report = (over: Partial<AppActionsReport> = {}): AppActionsReport => ({
  schema: 'phm.apps.actions/1', version: 1, generatedAt: new Date(NOW).toISOString(), source: 'available',
  actions: [
    entry(4, 'focus', 'Notes', 'needs-you', 'Sent to needs-you.'),
    entry(5, 'restart', 'Safari', 'no-result'),
    entry(7, 'quit', 'Chrome', 'refused', 'Chrome is your own browser.'),
    entry(9, 'open', 'Cursor', 'done', 'asked macOS to open Cursor.'),
  ],
  total: 4, counts: { done: 1, refused: 1, 'no-result': 1, 'needs-you': 1 }, lookups: 2, skipped: 0, truncated: false, ...over });

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function serve(body: unknown, status = 200) {
  const fetcher = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const card = () => screen.getByRole('region', { name: 'App actions' });

describe('App actions card', () => {
  it('lists every action newest first in plain words, with its logged detail and age', async () => {
    const fetcher = serve(report());
    render(<AppActionsCard visible />);
    const list = await within(card()).findByRole('list', { name: 'App actions, newest first' });
    expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Asked you before it would bring Notes to front4m agoSent to needs-you.',
      'Started to restart Safari; no result is on record5m ago',
      'Refused to quit Chrome7m agoChrome is your own browser.',
      'Opened Cursor9m agoasked macOS to open Cursor.',
    ]);
    expect(within(card()).getByText('4 actions on record · 1 refused · 1 waiting on you · 1 with no result on record')).toBeInTheDocument();
    expect(within(card()).getByText('2 lookups (list, status) are on record and not listed.')).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem').map(item => item.getAttribute('data-tone'))).toEqual(['warn', 'unknown', 'warn', 'ok']);
    expect(fetcher).toHaveBeenCalledWith('/api/verse/apps/actions', expect.anything());
    // The card reads; it offers nothing that acts on an app.
    expect(within(card()).getAllByRole('button').map(button => button.textContent)).toEqual(['All 4', 'Needs a look 3']);
  });

  it('Needs a look keeps only what did not plainly finish, and All brings the rest back', async () => {
    serve(report());
    render(<AppActionsCard visible />);
    const look = await within(card()).findByRole('button', { name: 'Needs a look 3' });
    expect(look).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(look);
    expect(look).toHaveAttribute('aria-pressed', 'true');
    const list = within(card()).getByRole('list', { name: 'App actions that need a look' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).queryByText('Opened Cursor')).toBeNull();
    fireEvent.click(within(card()).getByRole('button', { name: 'All 4' }));
    expect(within(card()).getByText('Opened Cursor')).toBeInTheDocument();
  });

  it('says so when nothing listed needs a look', async () => {
    serve(report({ actions: [entry(1, 'open', 'Cursor', 'done')], total: 1, counts: { done: 1 }, lookups: 0 }));
    render(<AppActionsCard visible />);
    fireEvent.click(await within(card()).findByRole('button', { name: 'Needs a look 0' }));
    expect(within(card()).getByText('Nothing in this list needs a look: every action listed finished.')).toBeInTheDocument();
    expect(within(card()).queryByRole('list')).toBeNull();
  });

  it('an unreadable feed is unknown, never an empty log', async () => {
    serve(report({ source: 'unavailable', actions: [], total: null, counts: {}, lookups: null }));
    render(<AppActionsCard visible />);
    expect(await within(card()).findByText('App actions are unknown: the feed could not be read.')).toBeInTheDocument();
    expect(within(card()).queryByText(/No app action/)).toBeNull();
    expect(within(card()).queryByRole('button')).toBeNull();
  });

  it('a feed with nothing in it says nothing is on record', async () => {
    serve(report({ source: 'missing', actions: [], total: 0, counts: {}, lookups: 0 }));
    render(<AppActionsCard visible />);
    expect(await within(card()).findByText('Nothing has been logged to the feed yet.')).toBeInTheDocument();
  });

  it('a read that fails or answers something else is unknown too', async () => {
    serve({ error: 'not found' }, 404);
    render(<AppActionsCard visible />);
    expect(within(card()).getByText('Reading app actions…')).toBeInTheDocument();
    expect(await within(card()).findByText(/^App actions are unknown: the log did not answer\./)).toBeInTheDocument();
    cleanup(); evictAll();
    serve({ schema: 'something.else', actions: [] });
    render(<AppActionsCard visible />);
    expect(await within(card()).findByText(/^App actions are unknown: the log did not answer\./)).toBeInTheDocument();
  });

  it('names what is not shown: a cut list and unreadable feed lines', async () => {
    serve(report({ total: 212, truncated: true, skipped: 1 }));
    render(<AppActionsCard visible />);
    expect(await within(card()).findByText(/^Showing the newest 4 of 212\./)).toBeInTheDocument();
    expect(within(card()).getByText('1 feed line could not be read and may hide an action.')).toBeInTheDocument();
  });

  it('does not read while hidden', () => {
    const fetcher = serve(report());
    render(<AppActionsCard visible={false} />);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('app actions model', () => {
  it('counts age in the unit that fits a week-long log', () => {
    const at = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
    expect([40, 12 * 60, 5 * 3600, 47 * 3600, 3 * 86_400].map(seconds => actionAgo(at(seconds), NOW))).toEqual(['40s ago', '12m ago', '5h ago', '1d 23h ago', '3d ago']);
    expect(actionAgo('not a time', NOW)).toBe('time unknown');
    expect(actionAgo(at(-30), NOW)).toBe('time unknown');
  });

  it('writes each outcome as a sentence and shows one it does not know as written', () => {
    const say = (action: string, outcome: string) => actionLine(entry(1, action, 'Safari', outcome), NOW);
    expect(say('quit', 'done')).toMatchObject({ title: 'Quit Safari', tone: 'ok' });
    expect(say('restart', 'failed')).toMatchObject({ title: 'Could not restart Safari', tone: 'bad' });
    expect(say('quit', 'needs_permission')).toMatchObject({ title: 'Needs a permission to quit Safari', tone: 'warn' });
    expect(say('quit', 'unknown')).toMatchObject({ title: 'Tried to quit Safari; the result is unknown', tone: 'unknown' });
    expect(say('quit', 'later-outcome')).toMatchObject({ title: 'quit Safari: later-outcome', tone: 'unknown' });
    expect(needsLook(entry(1, 'quit', 'Safari', 'done'))).toBe(false);
    expect(needsLook(entry(1, 'quit', 'Safari', 'unknown'))).toBe(true);
  });

  it('accepts only the log schema and reads a single action in the singular', () => {
    expect(narrowAppActions(report())).not.toBeNull();
    expect(narrowAppActions({ ...report(), actions: [{ key: 1 }] })).toBeNull();
    expect(narrowAppActions(null)).toBeNull();
    expect(actionsHeadline(report({ total: 1, counts: { done: 1 } }))).toBe('1 action on record');
    expect(actionsHeadline(report({ total: 0, counts: {} }))).toBe('No app action is on record in the last 7 days.');
  });
});
