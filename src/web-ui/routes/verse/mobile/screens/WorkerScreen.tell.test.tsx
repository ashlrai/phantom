import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { apiGet, ApiError } from '../../../../data/client.js';
import { resetGuard } from '../../shell/guard-store.js';
import { renderMobile, TOKEN } from '../mobile.test-support.js';
import { MobileToasts, resetMobileToastsForTest } from '../mobile-toast.js';
import { postFleetRunsInbox } from '../runs-queries.js';
import { WorkerScreen } from './WorkerScreen.js';

vi.mock('../../../../data/client.js', async (original) => ({
  ...await original<typeof import('../../../../data/client.js')>(), apiGet: vi.fn(),
}));
vi.mock('../runs-queries.js', async (original) => {
  const actual = await original<typeof import('../runs-queries.js')>();
  return { ...actual, postFleetRunsInbox: vi.fn(actual.postFleetRunsInbox) };
});

const snapshot = {
  v: 1, lastTick: null, claudeLane: null, switches: [], lanes: [], codexPersonal: null,
  mergesLastHour: { count: 0, items: [] },
  workers: [{ job: 'RQ-FAKE-31', repo: 'phantom', lane: 'codex-personal', tier: 'work', ageSeconds: 3120 }],
};
function showSnapshot() {
  vi.mocked(apiGet).mockImplementation(async (path) => {
    if (path.startsWith('/api/fleet/job')) throw new ApiError('fake refusal', 403, path);
    return snapshot;
  });
  setMutationToken(TOKEN);
  renderMobile(<><WorkerScreen job="RQ-FAKE-31" /><MobileToasts /></>);
}
afterEach(() => {
  clearMutationToken(); resetGuard(); resetMobileToastsForTest(); evictAll(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals();
});

it('prefills from the snapshot and sends edited text with the mobile source', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, at: null }), { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
  showSnapshot();
  const box = await screen.findByRole('textbox', { name: 'Your message' });
  expect(box).toHaveValue('Re RQ-FAKE-31 (codex-personal, phantom): running 52 min with no PR. ');
  await userEvent.clear(box);
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  await userEvent.type(box, 'Please check this job');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(postFleetRunsInbox).toHaveBeenCalledWith('Please check this job', TOKEN));
  expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ text: 'Please check this job', source: 'Phantom mobile' });
  expect(await screen.findByText("Landed in the leaders' inbox")).toBeInTheDocument();
  expect(box).toHaveValue('');
});

it('keeps the draft and shows the failure text on rejection', async () => {
  vi.mocked(postFleetRunsInbox).mockRejectedValueOnce(new Error('The leaders refused this message.'));
  showSnapshot();
  const box = await screen.findByRole('textbox', { name: 'Your message' });
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('The leaders refused this message.')).toBeInTheDocument();
  expect(box).toHaveValue('Re RQ-FAKE-31 (codex-personal, phantom): running 52 min with no PR. ');
});

it('prefills from detail when available', async () => {
  vi.mocked(apiGet).mockResolvedValue({ schema: 'fleet.job.v1', lane: 'fake-lane', publish: { prUrl: 'https://github.com/example/phantom/pull/31' } });
  renderMobile(<WorkerScreen job="RQ-FAKE-31" />);
  expect(await screen.findByRole('textbox', { name: 'Your message' })).toHaveValue('Re RQ-FAKE-31 (fake-lane): running age unknown, PR https://github.com/example/phantom/pull/31. ');
});

it('hides the section when neither detail nor snapshot exists', async () => {
  vi.mocked(apiGet).mockImplementation(async (path) => {
    if (path.startsWith('/api/fleet/job')) throw new ApiError('fake refusal', 403, path);
    return { ...snapshot, workers: [] };
  });
  renderMobile(<WorkerScreen job="RQ-FAKE-31" />);
  expect(await screen.findByText('This job is not in the current fleet snapshot.')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Tell the leaders' })).not.toBeInTheDocument();
});
