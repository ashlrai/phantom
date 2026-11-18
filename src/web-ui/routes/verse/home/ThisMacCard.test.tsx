import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHostTop } from '../../../../core/fleet/host-top.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { narrowHostTop, ThisMacCard } from './ThisMacCard.js';

const state = vi.hoisted(() => ({ read: { status: 'success', data: undefined as unknown } }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state.read, useRefetch: () => vi.fn() }));

const ps = readFileSync(join(process.cwd(), 'test', 'fixtures', 'host-top', 'busy-mac.txt'), 'utf8');
const REPORT = buildHostTop({ psText: ps, jobRoots: [{ jobId: 'RQ-ONE', pid: 300 }], load: { load1: 41.23, load5: 38, cores: 18 },
  swapText: 'vm.swapusage: total = 11264.00M  used = 10444.80M  free = 819.20M', pressureText: '2', totalBytes: 64 * 1024 ** 3, frontApp: '/Applications/Cursor.app', now: 0 });
let viewport: ViewportMock | null = null;
const show = (data: unknown, width = 390, status = 'success') => {
  viewport = mockViewport(width); state.read = { status, data };
  return render(<ThisMacCard />);
};
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; });

describe.each([['390 px', 390], ['desktop width', 1440]])('This Mac card at %s', (_name, width) => {
  it('shows the one-line suggestion, the top three buckets as bars and the load line, with no button', () => {
    show(REPORT, width);
    const card = within(screen.getByRole('region', { name: 'This Mac' }));
    expect(card.getByText('Docker is using 22 GB and 300% CPU; quit it if no lane needs it.')).toBeTruthy();
    expect(card.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Docker22 GB · 300% CPU', 'Local model server8.0 GB · 90% CPU', 'Chrome5.0 GB · 100% CPU']);
    expect(card.getAllByRole('img').map(bar => bar.getAttribute('aria-label'))).toEqual(['Docker: 34% of this Mac', 'Local model server: 13% of this Mac', 'Chrome: 8% of this Mac']);
    expect(card.getByText('Load 41.2 (38 over 5 minutes) on 18 cores · memory pressure warning · swap used 10.2 GB').getAttribute('data-pressure')).toBe('warning');
    expect(card.queryAllByRole('button')).toHaveLength(0);
  });
});

it('shows unknown as unknown, with no bars, when the process list could not be read', () => {
  show(buildHostTop({ psText: null, jobRoots: null, load: { load1: null, load5: null, cores: null }, now: 0 }));
  const card = within(screen.getByRole('region', { name: 'This Mac' }));
  expect(card.getByText('What is using this Mac is unknown: the process list could not be read.')).toBeTruthy();
  expect(card.getByText('Load unknown · memory pressure unknown · swap used unknown')).toBeTruthy();
  expect(card.queryAllByRole('listitem')).toHaveLength(0);
});

it('keeps the last reading with a note when a refresh fails, and hides for any other payload', () => {
  show(REPORT, 390, 'error');
  expect(screen.getByRole('status').textContent).toBe('This Mac could not refresh. Showing the last reading.');
  cleanup();
  for (const other of [undefined, null, [], { schema: 'home.v1' }, { ...REPORT, version: 2 }, { ...REPORT, buckets: [{ id: 'docker' }] }, { ...REPORT, suggestion: null }]) {
    expect(narrowHostTop(other)).toBeNull();
    const { container } = show(other);
    expect(container.innerHTML).toBe('');
    cleanup();
  }
  expect(narrowHostTop(JSON.parse(JSON.stringify(REPORT)))).toEqual(REPORT);
});
