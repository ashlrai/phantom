import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { admissionStatus } from '../../../../core/fleet/admission-status.js';
import { groupHostLoad } from '../../../../core/fleet/host-load.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { fleetAdmissionQuery } from '../fleet-hub/fleet-admission-query.js';
import { AdmissionCard } from './AdmissionCard.js';
import { json, renderMobile, stubFetch } from './mobile.test-support.js';
import { checkView } from './mobile-check.test-support.js';

afterEach(() => { evictAll(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const raw = () => ({ ts: Date.now() / 1000, last_admit: Date.now() / 1000 - 60,
  settle_s: 300, total_running: 10, max_total_running: 48 });
const field = (name: string) => screen.getByText(name).parentElement!.parentElement!;

it.each([
  ['settle', 'waiting between starts', '~240 sec'],
  ['over_host', 'host busy', 'unknown'],
  ['pool_empty', 'pool empty', 'unknown'],
  ['open', 'guard allows a start', '~0 sec'],
])('shows the shared admission reason for %s without a phone-side mapping', async (why, reason, next) => {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const report = admissionStatus(JSON.stringify({ ...raw(), why, ...(why === 'open' ? { last_admit: now / 1000 - 600 } : {}) }), now);
  const host = groupHostLoad('10 1 80 1024 /Applications/Codex.app/Contents/MacOS/Codex\n20 1 10 1024 /usr/bin/other', [], { load1: 12, cores: 8, now });
  const fetches = stubFetch({ 'GET /api/verse/fleet/admission': report, 'GET /api/verse/fleet/memory/host-load': host });
  const { container } = renderMobile(<AdmissionCard />);
  await waitFor(() => expect(field('Reason')).toHaveTextContent(report.reason));
  expect(report.reason).toBe(reason);
  expect(field('Running')).toHaveTextContent('10 of 48');
  expect(field('Next start')).toHaveTextContent(next);
  await waitFor(() => expect(field('Host load top cause')).toHaveTextContent('Desktop apps (80% CPU)'));
  expect(checkView('admission', 'Admission', container).findings).toEqual([]);
  expect(fetches.posts()).toEqual([]);
});

it.each(['missing', 'malformed', 'unknown', 'stale', 'failed-refresh'])('keeps %s readings unknown, including cached readings after an error', async kind => {
  const report = admissionStatus(JSON.stringify({ ...raw(), why: 'over_host' }));
  stubFetch({ 'GET /api/verse/fleet/admission': kind === 'missing' ? json({}, 404) : kind === 'malformed' ? {} : kind === 'unknown' ? admissionStatus(null)
    : kind === 'stale' ? { ...report, ts: Date.now() / 1000 - 301 } : report });
  renderMobile(<AdmissionCard />);
  if (kind === 'failed-refresh') {
    await waitFor(() => expect(field('Reason')).toHaveTextContent('host busy'));
    stubFetch({ 'GET /api/verse/fleet/admission': json({}, 503) });
    await refetchQuery(fleetAdmissionQuery.key, () => fleetAdmissionQuery.fetch(), true).catch(() => undefined);
  }
  await waitFor(() => expect(field('Reason')).toHaveTextContent('unknown'));
  const card = within(screen.getByRole('region', { name: 'Why jobs are waiting' }));
  expect(card.getByText('unknown of unknown')).toBeInTheDocument();
  expect(card.getAllByText('unknown')).toHaveLength(3);
});

it.each(['partial', 'stale', 'empty'])('keeps a %s host reading unknown without hiding admission', async kind => {
  const now = Date.now();
  const host = groupHostLoad(kind === 'empty' ? null : '10 1 80 1024 /usr/bin/worker',
    kind === 'partial' ? null : [], { load1: 12, cores: 8, now: kind === 'stale' ? now - 301_000 : now });
  stubFetch({ 'GET /api/verse/fleet/admission': admissionStatus(JSON.stringify({ ...raw(), why: 'over_host' })),
    'GET /api/verse/fleet/memory/host-load': host });
  renderMobile(<AdmissionCard />);
  await waitFor(() => expect(field('Reason')).toHaveTextContent('host busy'));
  expect(field('Host load top cause')).toHaveTextContent('unknown');
});
