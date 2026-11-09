import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { resetGuard } from '../../shell/guard-store.js';
import { MobileGuardSheet } from '../MobileGuardSheet.js';
import { resetMobileToastsForTest } from '../mobile-toast.js';
import { permissionsFor, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { WatchScreen } from './WatchScreen.js';

const fresh = (value: number | string | null) => ({
  value, source: 'test', observedAt: '2026-11-09T12:00:00.000Z', freshness: value === null ? 'unknown' : 'fresh',
});

function world() {
  return {
    schema: 'ashlr.world-model/v1',
    sensors: { lanes: [{ lane: 'claude-max', headroom: fresh(90) }] },
    outcomes: { repos: [{ repo: 'ashlrai/phantom', mergedPerDay: fresh(4) }] },
    releases: { updateCheck: fresh('staged'), train: fresh(null) },
    bottlenecks: { count: fresh(2) },
  };
}

function activity() {
  return {
    running: [{ sessionId: 's1', title: 'Phone view' }],
    completions: [{ sessionId: 's0', title: 'Queue claim', outcome: 'done', at: '2026-11-09T11:00:00.000Z' }],
  };
}

function thread() {
  return { messages: [{ id: 'm1', at: '2026-11-09T11:30:00.000Z', from: 'leader', channel: 'verse', kind: 'message', text: 'The bottleneck is CI.' }] };
}

function renderWatch() {
  return renderMobile(
    <>
      <WatchScreen />
      <MobileGuardSheet />
    </>,
  );
}

beforeEach(() => setMutationToken(TOKEN));
afterEach(() => {
  clearMutationToken();
  resetGuard();
  resetMobileToastsForTest();
  evictAll();
});

describe('WatchScreen', () => {
  it('shows the world, agent activity, and the owner thread, and sends a message', async () => {
    const stub = stubFetch({
      'GET /api/verse/world': world(),
      'GET /api/verse/activity': activity(),
      'GET /api/verse/leader/thread': thread(),
      'POST /api/verse/leader/thread': { message: { id: 'm2', at: '2026-11-09T12:01:00.000Z', from: 'mason', channel: 'verse', kind: 'message', text: 'Look at CI.' } },
    });
    renderWatch();
    expect(await screen.findByText('Lane claude-max: headroom 90')).toBeInTheDocument();
    expect(screen.getByText('Pulls ashlrai/phantom: 4 merged/day')).toBeInTheDocument();
    expect(screen.getByText('Release check: staged')).toBeInTheDocument();
    expect(screen.getByText('Release train: unknown')).toBeInTheDocument();
    expect(screen.getByText('Bottlenecks: 2')).toBeInTheDocument();
    expect(screen.getByText('Running: Phone view')).toBeInTheDocument();
    expect(screen.getByText('done: Queue claim')).toBeInTheDocument();
    expect(screen.getByText('Leader: The bottleneck is CI.')).toBeInTheDocument();

    await userEvent.type(screen.getByRole('textbox', { name: 'Message the Leader' }), 'Look at CI.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(stub.posts()).toHaveLength(1));
    expect(stub.posts()[0]).toMatchObject({ url: '/api/verse/leader/thread', body: { text: 'Look at CI.' }, headers: { 'x-ashlr-token': TOKEN } });
  });

  it('hides sending when the device is read-only', async () => {
    stubFetch({
      'GET /api/verse/world': world(),
      'GET /api/verse/activity': activity(),
      'GET /api/verse/leader/thread': thread(),
    });
    renderMobile(<WatchScreen />, { permissions: permissionsFor('unavailable') });
    expect(await screen.findByText('Lane claude-max: headroom 90')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message the Leader' })).toBeDisabled();
    expect(screen.getByText('Your Mac started Phantom without dispatch.')).toBeInTheDocument();
  });
});
