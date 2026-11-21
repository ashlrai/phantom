import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runway } from '../../../../core/usage/runway.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { mockViewport } from '../shell/viewport.test-support.js';
import { poolLine, PoolsCard } from './PoolsCard.js';

const row = (usedPercent: number | null, burnPerHour: number | null, hoursToReset: number | null) => runway({ pool: 'claude', usedPercent, burnPerHour, hoursToReset });
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });
describe('Pools card', () => {
  it.each([
    [row(97, 0.75, 50), '3% left, runs out in about 4 h, resets in 50 h', true],
    [row(null, null, null), 'usage unknown, runway unknown, reset unknown', false],
    [row(100, null, 5), '0% left, used up, resets in 5 h', true],
    [row(20, 1, 10), '80% left, runs out in about 80 h, resets in 10 h', false],
    [row(50, 0, 10), '50% left, nothing using it, resets in 10 h', false],
    [row(99, 1, 1.5), '1% left, runs out in about 1 h, resets in 2 h', true],
  ])('uses measured facts and flags any early exhaustion', (fixture, text, early) => {
    expect(poolLine(fixture)).toEqual({ text, early });
  });
  it.each([1440, 390])('shows all pools and opens only the selected pool jobs at %s px', async width => {
    const viewport = mockViewport(width);
    const calls = installFetch(({ path }) => path === '/api/usage/runway'
      ? json({ schema: 'pool.runway.v1', v: 1, asOf: null, headline: 'Ready', pools: [row(97, 0.75, 50)] })
      : json({ v: 1, generatedAt: '', lastTick: null, paused: null, claudeLane: null, lanes: [], leaders: [], inbox: [], codexPersonal: null,
        mergesLastHour: { count: null, items: [] }, workers: [{ job: 'Build', repo: 'demo', lane: 'claude', tier: 'work', ageSeconds: 1 },
          { job: 'Other', repo: 'demo', lane: 'grok', tier: 'work', ageSeconds: 1 }] }));
    const open = vi.fn();
    render(<PoolsCard onOpenJob={open} />);
    const claude = await screen.findByRole('button', { name: 'Claude: 3% left, runs out in about 4 h, resets in 50 h' });
    expect(claude).toHaveAttribute('data-warn', 'true');
    expect(screen.getAllByRole('button')).toHaveLength(8);
    expect(screen.getByRole('button', { name: 'Local: free, limited by memory' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'CMP Codex: usage unknown, runway unknown, reset unknown' })).not.toHaveAttribute('data-warn');
    expect(calls.calls.map(call => call.path).sort()).toEqual(['/api/fleet/local-capacity', '/api/usage/runway']);
    // The bar repeats the row's own reading: 97% used is drawn, an unread pool is unknown (never 0), and Local has no window to draw.
    expect(screen.getByRole('meter', { name: 'Claude used' })).toHaveAttribute('aria-valuenow', '97');
    const unread = screen.getByRole('meter', { name: 'CMP Codex used' });
    expect(unread).toHaveAttribute('aria-valuetext', 'unknown');
    expect(unread).not.toHaveAttribute('aria-valuenow');
    expect(screen.queryByRole('meter', { name: 'Local used' })).toBeNull();
    expect(screen.getAllByRole('meter')).toHaveLength(7);
    fireEvent.click(claude);
    fireEvent.click(await screen.findByRole('button', { name: 'Build' }));
    expect(open).toHaveBeenCalledWith('Build');
    expect(screen.queryByText('Other')).toBeNull();
    expect(claude).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(claude);
    expect(screen.queryByRole('region', { name: 'Claude running jobs' })).toBeNull();
    viewport.restore();
  });
  it.each([row(50, null, 10), { ...row(null, null, null), usedPercent: NaN }])('keeps missing and invalid burn readings unknown', fixture => {
    expect(poolLine(fixture).text).toContain('runway unknown');
    expect(poolLine(fixture).early).toBe(false);
  });
  it.each([json({}, 503), json({ pools: [] })])('keeps pools visible as unknown when readings fail', async response => {
    installFetch(() => response);
    render(<PoolsCard onOpenJob={vi.fn()} />);
    expect(await screen.findByRole('status')).toHaveTextContent('Pool readings unavailable');
    expect(within(screen.getByRole('region', { name: 'Pools' })).getAllByRole('button')).toHaveLength(8);
    expect(screen.getByRole('button', { name: 'Claude: usage unknown, runway unknown, reset unknown' })).toHaveTextContent(/usage unknown.*runway unknown.*reset unknown/);
    expect(screen.queryByText(/% left|Next reset|^Read /)).toBeNull();
    for (const meter of screen.getAllByRole('meter')) expect(meter.getAttribute('aria-valuenow')).toBeNull();
  });
  it('shows the room for local workers on the Local tile, on desktop and phone', async () => {
    const room = 'Room for 3 local workers (41 GB free, about 6 GB each, keeping 23 GB spare)';
    for (const width of [1440, 390]) {
      const viewport = mockViewport(width);
      installFetch(({ path }) => path === '/api/fleet/local-capacity' ? json({ schema: 'local.capacity.v1', workers: 3, summary: room })
        : json({ schema: 'pool.runway.v1', v: 1, asOf: null, headline: 'Ready', pools: [row(50, 0, 10)] }));
      const { unmount } = render(<PoolsCard onOpenJob={vi.fn()} />);
      expect(await screen.findByRole('button', { name: `Local: ${room}` })).toBeVisible();
      unmount(); evictAll(); viewport.restore?.();
    }
  });
});
