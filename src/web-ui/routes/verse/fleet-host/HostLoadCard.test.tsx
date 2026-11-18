import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { groupHostLoad } from '../../../../core/fleet/host-load.js';
import { evictAll } from '../../../data/cache.js';
import { HostLoadCard } from './HostLoadCard.js';
import { narrowHostLoad } from './host-load-query.js';

const ps = readFileSync(join(process.cwd(), 'test', 'fixtures', 'host-load', 'fleet-heavy.txt'), 'utf8');
const normal = groupHostLoad(ps, [{ jobId: 'RQ-ONE', pid: 400 }, { jobId: 'RQ-TWO', pid: 500 }], { load1: 74.2, cores: 18, now: 0 });
const serve = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));

beforeEach(() => evictAll());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('renders the top line, one stacked bar and a row per group', async () => {
  serve(normal);
  const { container } = render(<HostLoadCard visible />);
  expect(await screen.findByText('Load 74: 61 from fleet workers, 7 from local models, 2 from desktop apps, 4 other')).toBeInTheDocument();
  const bar = screen.getByRole('img', { name: /^Processor share: Fleet workers 82%, Local models 9%, Desktop apps 3%, System 0%, Other 5%$/ });
  expect([...bar.children].map(part => [part.getAttribute('data-group'), (part as HTMLElement).style.flexGrow]))
    .toEqual([['fleet-workers', '800.5'], ['local-models', '90'], ['desktop-apps', '30'], ['system', '2.5'], ['other', '50.1']]);
  expect(container.querySelectorAll('li')).toHaveLength(5);
  expect(screen.getByText(/Fleet workers: 61 load · 800.5% CPU · 2480 MB · 6 processes/)).toHaveTextContent('top: RQ-ONE, RQ-TWO');
});

it('renders the empty reading as unknown, with no bar', async () => {
  serve(groupHostLoad(null, null, { load1: 80, cores: 18 }));
  render(<HostLoadCard visible />);
  expect(await screen.findByText('Load 80: sources unknown')).toBeInTheDocument();
  expect(screen.getByText('The process list is unavailable, so the sources of load are unknown.')).toBeInTheDocument();
  expect(screen.queryByRole('img')).toBeNull();
});

it('says when job roots are unknown', async () => {
  serve(groupHostLoad(ps, null, { load1: 74, cores: 18 }));
  render(<HostLoadCard visible />);
  expect(await screen.findByText(/Fleet job roots are unknown/)).toBeInTheDocument();
});

it('renders nothing for a missing route or a malformed report', async () => {
  serve({}, 404);
  const { container } = render(<HostLoadCard visible />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  await waitFor(() => expect(container).toBeEmptyDOMElement());
  expect(narrowHostLoad({ ...normal, version: 2 })).toBeNull();
  expect(narrowHostLoad({ ...normal, groups: [{ id: 'other' }] })).toBeNull();
  expect(narrowHostLoad(normal)).toBe(normal);
});
