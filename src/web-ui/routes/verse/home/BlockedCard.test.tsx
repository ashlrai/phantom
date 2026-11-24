import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { LaunchStallViewV1 } from '../../../../core/verse/fleet-launch-stall-api.js';
import { takeRequestedLane } from '../fleet-lanes/lane-focus-request.js';
import { isLaunchStallViewV1 } from '../fleet-lanes/launch-stall-queries.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { BLOCKED_LIVE_PATH, BlockedCard, blockedLiveQuery } from './BlockedCard.js';
import { blockedView, holdUntil, liveOf } from './blocked-model.js';

type Read = { status: string; data: unknown; error?: unknown };
const state = vi.hoisted(() => ({ reads: {} as Record<string, { status: string; data: unknown; error?: unknown }> }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: (def: { key: string }) => state.reads[def.key] ?? { status: 'loading', data: undefined }, useRefetch: () => vi.fn() }));

const LIVE_KEY = 'home-blocked-live', STALL_KEY = 'verse-fleet-launch-stall';
const AT = '2026-11-17T12:00:00.000Z';
const live = (over: Record<string, unknown> = {}) => ({ v: 1, generatedAt: AT, summary: { parked: 0 }, blockedHolds: [], ...over }) as unknown as FleetLiveSnapshotV1;
const stall = (over: Partial<LaunchStallViewV1> = {}): LaunchStallViewV1 => ({ v: 1, generatedAt: AT, source: 'ok', lanes: [],
  stall: { startTime: null, minutes: null, lastQ: null, lastReap: null, min: 30, stalled: false }, why: { code: 'none', line: 'Launches are not blocked.', detail: [] }, ...over });
const HOLDS = [{ repo: 'ashlrai/phantom', reason: 'Main is red: the gate failed on a fake check.', until: null }, { repo: 'ashlrai/locus', reason: 'Merge cap reached.', until: '2026-11-17T15:40:00.000Z' }];
const STUCK = stall({
  stall: { startTime: '2026-11-17 11:15:00', minutes: 42.3, lastQ: 5, lastReap: 0, min: 30, stalled: true },
  why: { code: 'load-gate', line: 'Launches are paused: the load gate is closed.', detail: ['Load is 14.2; the gate opens under 12.'] },
  lanes: [{ lane: 'claude', jobs: [{ job: 'RQ-A', ageMinutes: 52.4 }, { job: 'RQ-B', ageMinutes: 31 }] }, { lane: 'codex-local', jobs: [{ job: 'RQ-C', ageMinutes: 47 }] }],
});

let viewport: ViewportMock | null = null;
const open = vi.fn();
const ok = (data: unknown): Read => ({ status: 'success', data });
const down = (data?: unknown): Read => ({ status: 'error', data, error: new Error('down') });
const show = (liveRead: Read | undefined, stallRead: Read | undefined, width = 1440) => {
  viewport = mockViewport(width);
  state.reads = { ...(liveRead ? { [LIVE_KEY]: liveRead } : {}), ...(stallRead ? { [STALL_KEY]: stallRead } : {}) };
  return render(<BlockedCard open={open} />);
};
const card = () => within(screen.getByRole('region', { name: 'Blocked' }));
beforeEach(() => { open.mockClear(); takeRequestedLane(); });
afterEach(() => { cleanup(); viewport?.restore(); });

it('the fixtures are what the two routes send', () => {
  expect(isLaunchStallViewV1(STUCK)).toBe(true);
  expect(liveOf(live())).not.toBeNull();
  expect([blockedLiveQuery.key, BLOCKED_LIVE_PATH]).toEqual([LIVE_KEY, '/api/verse/fleet/live']);
});

describe.each([['desktop width', 1440], ['390 px', 390]])('Blocked card at %s', (_name, width) => {
  it('names everything that is stopping work: launches, repo holds, waiting lanes and parked jobs', () => {
    show(ok(live({ blockedHolds: HOLDS, summary: { parked: 4 } })), ok(STUCK), width);
    const headline = card().getByText('Blocked: 2 repos held, launches paused, 3 jobs waiting in 2 lanes, 4 parked.');
    expect(headline.getAttribute('data-state')).toBe('blocked');
    const launches = within(card().getByRole('group', { name: 'Launches' }));
    expect(launches.getByText('Launches are paused: the load gate is closed.')).toBeTruthy();
    expect(launches.getByText('Load is 14.2; the gate opens under 12.')).toBeTruthy();
    expect(launches.getByText('No job has launched for 42 min. 5 jobs are queued.')).toBeTruthy();
    const holds = within(card().getByRole('list', { name: 'Repo holds' })).getAllByRole('listitem');
    expect(holds.map(row => row.textContent)).toEqual([
      'ashlrai/phantomuntil clearedMain is red: the gate failed on a fake check.',
      expect.stringMatching(/^ashlrai\/locusuntil .*\d.*Merge cap reached\.$/),
    ]);
    const lanes = within(card().getByRole('list', { name: 'Lanes with waiting jobs' })).getAllByRole('button');
    expect(lanes.map(row => row.textContent)).toEqual(['claudeoldest 52 min2 jobs waiting with nothing running.', 'codex-localoldest 47 min1 job waiting with nothing running.']);
    expect(card().getByText('Parked jobs: 4')).toBeTruthy();
    expect(card().queryByText(/unknown/i)).toBeNull();
  });

  it('a clear fleet says so in words, and only when every reading was made', () => {
    show(ok(live()), ok(stall()), width);
    expect(card().getByText('Nothing is blocked.').getAttribute('data-state')).toBe('clear');
    expect(card().queryByRole('list')).toBeNull();
    expect(card().queryByText(/Parked jobs/)).toBeNull();
    expect(card().getAllByRole('button')).toHaveLength(1);
  });
});

it('a lane row opens Lanes on that lane; the one action opens Lanes', () => {
  show(ok(live()), ok(STUCK));
  fireEvent.click(card().getByRole('button', { name: 'Show lane codex-local' }));
  expect(open).toHaveBeenLastCalledWith('fleet-lanes');
  expect(takeRequestedLane()).toBe('codex-local');
  fireEvent.click(card().getByRole('button', { name: 'Open Lanes' }));
  expect(open).toHaveBeenCalledTimes(2);
  expect(takeRequestedLane()).toBeNull();
});

it('a reading that could not be made is unknown, never "nothing is blocked"', () => {
  // The hold store and the parked count are unreadable; launches are known clear.
  show(ok(live({ blockedHolds: null, summary: { parked: null } })), ok(stall()));
  expect(card().getByText('Nothing is recorded as blocked, but not every reading could be made.').getAttribute('data-state')).toBe('unknown');
  expect(card().getByText('Repo holds: unknown (the hold list could not be read).').hasAttribute('data-unknown')).toBe(true);
  expect(card().getByText('Parked jobs: unknown (the count was not recorded).')).toBeTruthy();
  cleanup();
  // The live read failed outright; what the dispatcher says still shows.
  show(down(), ok(STUCK));
  expect(card().getByText('Blocked: launches paused, 3 jobs waiting in 2 lanes.')).toBeTruthy();
  expect(card().getByText('Repo holds and parked jobs: unknown (the live fleet status could not be read).')).toBeTruthy();
  cleanup();
  // Both failed: the card still says what it does not know and still opens Lanes.
  show(down(), down());
  expect(card().getByText('Launches and waiting jobs: unknown (the dispatcher status could not be read).')).toBeTruthy();
  expect(card().queryByText('Nothing is blocked.')).toBeNull();
  expect(card().getByRole('button', { name: 'Open Lanes' })).toBeTruthy();
});

it('the dispatcher not knowing why, or its log being unreadable, is unknown rather than a block', () => {
  show(ok(live()), ok(stall({ why: { code: 'unknown', line: 'The admission snapshot could not be read.', detail: [] } })));
  expect(card().getByText('Launches: unknown (The admission snapshot could not be read.)')).toBeTruthy();
  expect(card().queryByRole('group', { name: 'Launches' })).toBeNull();
  cleanup();
  show(ok(live()), ok(stall({ source: 'unavailable', stall: null, why: null })));
  expect(card().getByText('Launches: unknown (the dispatcher log could not be read on this computer).')).toBeTruthy();
});

it('a build without the launch-stall route still reports holds, without calling launches unknown', () => {
  show(ok(live({ blockedHolds: HOLDS.slice(0, 1) })), ok(null));
  expect(card().getByText('Blocked: 1 repo held.')).toBeTruthy();
  expect(card().queryByText(/unknown/i)).toBeNull();
});

it('a failed refresh keeps the last reading and says it may be stale', () => {
  show(down(live({ blockedHolds: HOLDS })), ok(stall()));
  expect(card().getByRole('status').textContent).toBe('Could not refresh. Showing the last reading, which may be stale.');
  expect(card().getByText('Blocked: 2 repos held.')).toBeTruthy();
});

it('stays hidden until both reads settle, and for a payload that is neither reading', () => {
  show(undefined, undefined);
  expect(screen.queryByRole('region', { name: 'Blocked' })).toBeNull();
  cleanup();
  // One half must not speak for the whole: holds alone could say "nothing is blocked" while launches are paused.
  show(ok(live()), undefined);
  expect(screen.queryByRole('region', { name: 'Blocked' })).toBeNull();
  cleanup();
  show(ok({ schema: 'home.v1' }), ok({ schema: 'home.v1' }));
  expect(screen.queryByRole('region', { name: 'Blocked' })).toBeNull();
});

describe('blocked model', () => {
  it('counts one job as one job and reports the oldest wait per lane', () => {
    const view = blockedView(live(), stall({ lanes: [{ lane: 'grok', jobs: [{ job: 'RQ-Z', ageMinutes: 33.6 }] }] }));
    expect(view.headline).toBe('Blocked: 1 job waiting in 1 lane.');
    expect(view.lanes).toEqual([{ lane: 'grok', waiting: 1, oldestMinutes: 34 }]);
  });
  it('a snapshot from before holds existed leaves holds unknown', () => {
    const view = blockedView(liveOf({ v: 1, generatedAt: AT, summary: { parked: 0 } }), stall());
    expect([view.blocked, view.holds, view.unknown]).toEqual([false, [], ['Repo holds: unknown (the hold list could not be read).']]);
  });
  it('says when a hold lifts without inventing a time', () => {
    const now = Date.parse(AT);
    expect(holdUntil(null, now)).toBe('until cleared');
    expect(holdUntil('not a time', now)).toBe('until an unknown time');
    expect(holdUntil('2026-11-17T12:30:00.000Z', now)).toMatch(/^until .*\d/);
    // Another day carries its date, so "until 3:40" is never read as today.
    expect(holdUntil('2026-11-20T12:30:00.000Z', now)).toMatch(/20/);
  });
  it('rejects anything that is not a v1 live snapshot', () => {
    for (const body of [null, 'x', {}, { v: 2, generatedAt: AT, summary: {} }, { v: 1, generatedAt: AT, summary: null }]) expect(liveOf(body)).toBeNull();
  });
});

it('every color and size the Blocked styles name is a real design token', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), 'src/web-ui', path), 'utf8');
  const defined = new Set((read('design/tokens.css') + read('design/global.css')).match(/--[\w-]+(?=\s*:)/g));
  const used = read('routes/verse/home/blocked.module.css').match(/var\((--[\w-]+)/g)!.map(token => token.slice(4));
  expect(used.filter(token => !defined.has(token))).toEqual([]);
});

 it('keeps malformed hold rows and invalid parked counts unknown instead of crashing or inventing a count', () => {
  for (const holds of [[null], [{ repo: 'example/repo', reason: {}, until: null }]]) {
    const view = blockedView(live({ blockedHolds: holds }), stall());
    expect(view.holds).toEqual([]);
    expect(view.unknown).toContain('Repo holds: unknown (the hold list could not be read).');
    expect(view.headline).not.toBe('Nothing is blocked.');
  }
  for (const parked of [-1, NaN, Infinity, 1.5]) {
    const view = blockedView(live({ summary: { parked } }), stall());
    expect(view.parked).toBeNull();
    expect(view.unknown).toContain('Parked jobs: unknown (the count was not recorded).');
    expect(view.headline).not.toBe('Nothing is blocked.');
  }
 });
