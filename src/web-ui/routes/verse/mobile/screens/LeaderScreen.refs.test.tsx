import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { leaderState } from '../../command/fixtures.test-support.js';
import { msg } from '../../leader/thread-fixtures.test-support.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { LeaderScreen } from './LeaderScreen.js';

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

it('links references in leader messages to the worker and GitHub', async () => {
  const text = 'Watch RQ-PHX-EXAMPLE01 and PR #2495.';
  stubFetch({
    'GET /api/verse/leader/thread': { messages: [
      msg({ id: 'leader', from: 'leader', text }),
      msg({ id: 'mason', from: 'mason', text }),
      msg({ id: 'plain', from: 'leader', text: 'Nothing to follow.' }),
    ] },
    'GET /api/verse/leader/directives': { directives: [], retired: [] },
    'GET /api/verse/leader': leaderState('live'),
    'GET /api/verse/fleet/runs': { v: 1, lastTick: null, claudeLane: null, switches: [], lanes: [], mergesLastHour: { count: null }, codexPersonal: null },
  });
  const navigate = vi.fn();
  renderMobile(<LeaderScreen />, { navigate });
  const rows = await screen.findAllByRole('group', { name: 'Referenced jobs and PRs' });
  expect(rows).toHaveLength(1);
  fireEvent.click(within(rows[0]!).getByRole('button', { name: 'RQ-PHX-EXAMPLE01' }));
  expect(navigate).toHaveBeenCalledWith({ screen: 'worker', job: 'RQ-PHX-EXAMPLE01' });
  const link = within(rows[0]!).getByRole('link', { name: 'PR #2495' });
  expect(link).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/2495');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});
