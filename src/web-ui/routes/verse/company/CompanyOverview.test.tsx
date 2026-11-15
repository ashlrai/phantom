import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { CompanyOverview } from './CompanyOverview.js';
import { at, payloads, sessions } from './company.test-support.js';

const sessionRead = { data: sessions, status: 'success' as const, updatedAt: Date.now(), error: undefined };
function serve(data = payloads()) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const value = data[String(input)];
    return Response.json(value ?? {}, { status: value === undefined ? 503 : 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const tile = (label: string) => within(screen.getByText(label).closest('div')!);
afterEach(() => { cleanup(); evictAll(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows org counts and distinct shared fleet totals without rendering private or unrelated fields', async () => {
  const data = payloads();
  data['/api/verse/fleet/control/org'] = { ...data['/api/verse/fleet/control/org'] as object,
    membersPrivate: [{ name: 'PRIVATE-MEMBER', mail: 'PRIVATE-MAIL', usage: 'PRIVATE-USAGE', auth: 'PRIVATE-AUTH' }],
    joins: [{ machine: 'PRIVATE-HOST', share: 'PRIVATE-SHARE' }], file: '/PRIVATE-PATH/org.toml' };
  data['/api/verse/fleet/live'] = { ...data['/api/verse/fleet/live'] as object, runs: [{ prompt: 'PRIVATE-PROMPT' }], incidents: ['PRIVATE-INCIDENT'] };
  const fetch = serve(data);
  const { container } = render(<CompanyOverview enabled sessions={sessionRead} />);
  expect(await tile('Members').findByText('3')).toBeInTheDocument();
  expect(tile('Contributing members').getByText('2')).toBeInTheDocument();
  expect(tile('Lanes contributed').getByText('1')).toBeInTheDocument();
  expect(tile('Fleet jobs running').getByText('1')).toBeInTheDocument();
  expect(await tile('Fleet merges today (ET)').findByText('13')).toBeInTheDocument();
  expect(container.innerHTML).not.toContain('PRIVATE-');
  expect(fetch.mock.calls).toHaveLength(2);
});

it('shows missing org as unknown while retaining real fleet totals; empty opt-in is an honest zero', async () => {
  const data = payloads();
  data['/api/verse/fleet/control/org'] = { schema: 'company.org.v1', generatedAt: at(), sources: { org: 'unavailable', joins: 'unavailable' }, members: null, contributingMembers: null, contributingLanes: null };
  serve(data);
  render(<CompanyOverview enabled sessions={sessionRead} />);
  expect(await screen.findByText(/No org membership reading/)).toBeInTheDocument();
  expect(tile('Members').getByText('unknown')).toBeInTheDocument();
  expect(await tile('Fleet merges today (ET)').findByText('13')).toBeInTheDocument();
  data['/api/verse/fleet/control/org'] = { ...data['/api/verse/fleet/control/org'] as object,
    sources: { org: 'available', joins: 'missing' }, members: 3, contributingMembers: 0, contributingLanes: 0 };
  fireEvent.click(screen.getByRole('button', { name: 'Refresh overview' }));
  expect(await screen.findByText(/No lane contributions recorded/)).toBeInTheDocument();
  expect(tile('Lanes contributed').getByText('0')).toBeInTheDocument();
});

it('keeps membership when joins fail and refuses invalid fleet counts or a degraded session source', async () => {
  const data = payloads();
  data['/api/verse/fleet/control/org'] = { ...data['/api/verse/fleet/control/org'] as object,
    sources: { org: 'available', joins: 'invalid' }, contributingMembers: 9, contributingLanes: 9 };
  data['/api/verse/fleet/live'] = { ...data['/api/verse/fleet/live'] as object, summary: { mergedToday: -1 } };
  serve(data);
  render(<CompanyOverview enabled sessions={{ ...sessionRead, data: { ...sessions, sourceState: 'degraded' } }} />);
  expect(await tile('Members').findByText('3')).toBeInTheDocument();
  expect(tile('Lanes contributed').getByText('unknown')).toBeInTheDocument();
  expect(tile('Fleet jobs running').getByText('unknown')).toBeInTheDocument();
  expect(tile('Fleet merges today (ET)').getByText('unknown')).toBeInTheDocument();
  expect(screen.getByText(/Lane opt-in records unavailable/)).toBeInTheDocument();
});

it('labels retained org readings after failures and bounded running counts; merge failures stay independent', async () => {
  const data = payloads();
  serve(data);
  render(<CompanyOverview enabled sessions={{ ...sessionRead, data: { ...sessions, truncated: true } }} />);
  expect(await tile('Members').findByText('3')).toBeInTheDocument();
  expect(tile('Fleet jobs running').getByText('≥ 1')).toBeInTheDocument();
  delete data['/api/verse/fleet/control/org'];
  delete data['/api/verse/fleet/live'];
  fireEvent.click(screen.getByRole('button', { name: 'Refresh overview' }));
  expect(await screen.findByText(/Organization refresh failed.*Last reading retained/)).toBeInTheDocument();
  expect(tile('Members').getByText('3')).toBeInTheDocument();
  expect(await screen.findByText('Fleet merge totals unavailable.')).toBeInTheDocument();
  expect(tile('Fleet merges today (ET)').getByText('unknown')).toBeInTheDocument();
});

it('starts new reads together and polls only while enabled', async () => {
  vi.useFakeTimers();
  const fetch = serve();
  const view = render(<CompanyOverview enabled={false} sessions={sessionRead} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetch).not.toHaveBeenCalled();
  view.rerender(<CompanyOverview enabled sessions={sessionRead} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fetch).toHaveBeenCalledTimes(4);
  view.rerender(<CompanyOverview enabled={false} sessions={sessionRead} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('does not call yesterday’s retained total today’s merges', async () => {
  const data = payloads();
  data['/api/verse/fleet/live'] = { ...data['/api/verse/fleet/live'] as object, generatedAt: at(86_400) };
  serve(data);
  render(<CompanyOverview enabled sessions={sessionRead} />);
  expect(await tile('Members').findByText('3')).toBeInTheDocument();
  expect(tile('Fleet merges today (ET)').getByText('unknown')).toBeInTheDocument();
});
