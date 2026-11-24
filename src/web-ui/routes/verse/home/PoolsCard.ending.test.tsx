import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runway, type RunwaySnapshot } from '../../../../core/usage/runway.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { PoolsCard } from './PoolsCard.js';

const short = runway({ pool: 'claude', usedPercent: 97, burnPerHour: 0.75, hoursToReset: 50 });
const spare = runway({ pool: 'grok', usedPercent: 20, burnPerHour: 1, hoursToReset: 10 });
const unburnt = runway({ pool: 'zai', usedPercent: 50, burnPerHour: null, hoursToReset: 10 });
const runs = { v: 1, generatedAt: '', lastTick: null, paused: null, claudeLane: null, lanes: [], leaders: [], inbox: [], codexPersonal: null,
  mergesLastHour: { count: null, items: [] }, workers: [] };
const show = (pools: RunwaySnapshot['pools']) => {
  installFetch(({ path }) => path === '/api/usage/runway' ? json({ schema: 'pool.runway.v1', v: 1, asOf: '2026-11-18T12:00:00.000Z', headline: 'Fixture', pools }) : json(runs));
  return render(<PoolsCard onOpenJob={vi.fn()} />);
};
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('Pools card: how each pool ends its window', () => {
  it('says on each tile how the window ends and splits the bar the same way', async () => {
    show([short, spare, unburnt]);
    const claude = await screen.findByRole('button', { name: /^Claude: 3% left/ });
    expect(within(claude).getByText('dry 46 h before its reset')).toHaveAttribute('data-ending', 'dry');
    const dry = screen.getByRole('meter', { name: 'Claude used' });
    expect(dry).toHaveAttribute('data-ending', 'dry');
    expect(dry).toHaveAttribute('aria-valuetext', '97% used, dry 46 h before its reset');
    expect([...dry.children].map(part => (part as HTMLElement).style.width)).toEqual(['97%', '3%']);

    // Used so far, then what this burn uses by the reset; the 70% after them is the gap left unused.
    expect(within(screen.getByRole('button', { name: /^Grok: 80% left/ })).getByText('70% unused at its reset')).toHaveAttribute('data-ending', 'unused');
    const grok = screen.getByRole('meter', { name: 'Grok used' });
    expect(grok).toHaveAttribute('aria-valuenow', '20');
    expect(grok).toHaveAttribute('aria-valuetext', '20% used, 10% more by its reset, 70% unused at its reset');
    expect([...grok.children].map(part => (part as HTMLElement).style.width)).toEqual(['20%', '10%']);
    expect([...grok.children].map(part => part.getAttribute('data-part'))).toEqual(['used', 'more']);
  });
  it('projects nothing without a burn reading and draws no bar parts without a usage reading', async () => {
    show([short, spare, unburnt]);
    const zai = await screen.findByRole('button', { name: /^Z\.ai: 50% left, runway unknown/ });
    expect(within(zai).getByText('not projected: no burn rate yet')).toBeVisible();
    const half = screen.getByRole('meter', { name: 'Z.ai used' });
    expect(half).toHaveAttribute('data-ending', 'unprojected');
    expect([...half.children].map(part => (part as HTMLElement).style.width)).toEqual(['50%']);
    // Devin is on the bar with no row at all: hatched by its state, no parts, no extra line, no number.
    const devin = screen.getByRole('meter', { name: 'Devin used' });
    expect(devin).toHaveAttribute('data-ending', 'unread');
    expect(devin).toHaveAttribute('aria-valuetext', 'unknown');
    expect(devin).not.toHaveAttribute('aria-valuenow');
    expect(devin.children).toHaveLength(0);
    expect(screen.getByRole('button', { name: /^Devin: usage unknown/ }).querySelector('[data-ending]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Local: free, limited by memory' }).querySelector('[data-ending]')).toBeNull();
  });
  it('counts the endings under the tiles with the key to the bars', async () => {
    show([short, spare, unburnt]);
    await screen.findByRole('button', { name: /^Claude: 3% left/ });
    const key = within(screen.getByRole('region', { name: 'Pools' })).getByText('At this burn: 1 runs dry early, 1 leaves usage unused, 5 not projected.').closest('p')!;
    expect(key).toHaveTextContent(/used so far.*more by its reset.*unused at its reset/);
  });
  it('gives no key when no pool can be projected, and nothing at all when the read fails', async () => {
    const first = show([unburnt]);
    expect(await screen.findByText('No pool can be projected: each lacks a usage, burn or reset reading.')).toBeVisible();
    expect(screen.queryByText('used so far')).toBeNull();
    first.unmount(); evictAll(); vi.unstubAllGlobals();
    installFetch(() => json({}, 503));
    render(<PoolsCard onOpenJob={vi.fn()} />);
    expect(await screen.findByRole('status')).toHaveTextContent('Pool readings unavailable');
    expect(document.querySelector('[data-ending-key]')).toBeNull();
    for (const meter of screen.getAllByRole('meter')) expect(meter).toHaveAttribute('data-ending', 'unread');
  });
  it('shows the runway\'s advice for the open pool above its jobs', async () => {
    show([short, spare]);
    fireEvent.click(await screen.findByRole('button', { name: /^Claude: 3% left/ }));
    const jobs = await screen.findByRole('region', { name: 'Claude running jobs' });
    expect(within(jobs).getByText(`Runway advice: ${short.advice}`)).toBeVisible();
    expect(short.advice).toContain('frontier and high-yield work only');
    // A pool the snapshot does not hold, and Local, have no advice to show.
    fireEvent.click(screen.getByRole('button', { name: /^Devin: usage unknown/ }));
    expect(within(await screen.findByRole('region', { name: 'Devin running jobs' })).queryByText(/^Runway advice/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Local: free, limited by memory' }));
    expect(within(await screen.findByRole('region', { name: 'Local running jobs' })).queryByText(/^Runway advice/)).toBeNull();
  });
});
