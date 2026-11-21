import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { evictAll } from '../../../data/cache.js';
import { setMutationToken } from '../../../data/auth-store.js';
import { BuildLimitsRow } from './BuildLimitsRow.js';
import { BUILD_STALE_LIMITS_PATH, narrowBuildStaleLimits } from './build-stale-limits-queries.js';

const view = (saved: { commits: number | null; hours: number | null }, envCommits = false) => ({
  schema: 'ashlr.build-stale-limits.v1', limits: { commits: saved.commits ?? 50, hours: saved.hours ?? 24 }, saved,
  defaults: { commits: 50, hours: 24 }, envOverride: { commits: envCommits, hours: false },
  ranges: { commits: { min: 1, max: 10_000 }, hours: { min: 1, max: 8_760 } } });

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

function mount(initial: ReturnType<typeof view>, after = initial) {
  let current = initial;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { current = after; return Response.json(after); }
    return Response.json(current);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<ToastProvider><BuildLimitsRow /></ToastProvider>);
  return fetcher;
}

it('rejects malformed answers', () => {
  expect(narrowBuildStaleLimits({ schema: 'x' })).toBeNull();
  expect(narrowBuildStaleLimits({ ...view({ commits: null, hours: null }), limits: { commits: 'a', hours: 1 } })).toBeNull();
  expect(narrowBuildStaleLimits(view({ commits: 5, hours: null }))).not.toBeNull();
});

it('shows the defaults, and says when the environment overrides a limit', async () => {
  mount(view({ commits: null, hours: null }, true));
  expect(await screen.findByLabelText('Commits behind master')).toHaveValue(50);
  expect(screen.getByLabelText('Hours since a missed merge')).toHaveValue(24);
  expect(screen.getByText(/ASHLR_BUILD_STALE_COMMITS is set in the environment, so 50 is in force/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Reset to defaults' })).not.toBeInTheDocument();
});

it('without the mutation hold the inputs are disabled and say why', async () => {
  mount(view({ commits: null, hours: null }));
  expect(await screen.findByLabelText('Commits behind master')).toBeDisabled();
  expect(screen.getByText(/Unlock the mutation hold/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
});

it('saves an edited limit with the token, and can reset', async () => {
  setMutationToken('tok');
  const fetcher = mount(view({ commits: null, hours: null }), view({ commits: 80, hours: null }));
  const input = await screen.findByLabelText('Commits behind master');
  const save = screen.getByRole('button', { name: 'Save' });
  expect(save).toBeDisabled();
  await userEvent.clear(input);
  await userEvent.type(input, '0');
  expect(save).toBeDisabled(); // out of range
  await userEvent.clear(input);
  await userEvent.type(input, '80');
  await userEvent.click(save);
  await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(String(post[0])).toBe(BUILD_STALE_LIMITS_PATH);
  expect(JSON.parse(String(post[1]?.body))).toEqual({ commits: 80, hours: 24 });
  expect(await screen.findByRole('button', { name: 'Reset to defaults' })).toBeInTheDocument();
});
