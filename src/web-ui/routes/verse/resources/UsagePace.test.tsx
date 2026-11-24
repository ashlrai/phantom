import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { UsagePace } from './UsagePace.js';
import { poolShareSnapshot } from '../../../../core/usage/runway.js';

const PATH = '/api/verse/usage-resources';
const none = { usedPercent: null, burnPerHour: null, hoursToReset: null };
const fourPools = () => poolShareSnapshot([{ pool: 'zai', ...none }, { pool: 'gemini', ...none },
  { pool: 'claude', usedPercent: 1, burnPerHour: 0.1, hoursToReset: 50 },
  { pool: 'codex-personal', usedPercent: 97, burnPerHour: 1, hoursToReset: 72 }], null);
const rows = () => within(screen.getByRole('list', { name: 'Where to send work' })).getAllByRole('listitem');
const row = (pool: string) => rows().find(item => item.getAttribute('data-pool') === pool)!;

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());

it('shows the pacer forecast once per pool and unknown for missing evidence when the report holds no shares', async () => {
  stubSurfaceFetch({ routes: { [PATH]: { pace: { v: 1, asOf: new Date().toISOString(), pools: [
    { pool: 'codex-personal', projectedPercent: 64, hoursLeft: 123.6, recommendedSlots: 18 },
    { pool: 'claude', projectedPercent: null, hoursLeft: null },
  ] } } } });
  render(<UsagePace />);
  expect(await screen.findByText(/on pace to use 64% before reset \(123.6 h left\)/)).toBeVisible();
  expect(screen.getAllByText(/on pace to use 64%/)).toHaveLength(1);
  expect(row('codex-personal')).toHaveTextContent('this server sent no pool shares · pacer forecast: on pace to use 64% before reset (123.6 h left) · about 36% unused at reset · suggested running slots 18');
  expect(rows()).toHaveLength(4);
  expect(rows().filter(item => item.textContent?.endsWith('suggested running slots unknown'))).toHaveLength(3);
  // No shares from this (older) payload: the headline says unknown, never a guess, and no bar draws a share.
  expect(document.querySelector('[data-headline]')).toHaveTextContent('Where to send work: unknown.');
  expect(document.querySelector('[data-pace-note]')).toHaveTextContent('This server sent no pool shares with its report.');
  expect(document.querySelector('[data-split]')).toBeNull();
  for (const meter of screen.getAllByRole('meter')) {
    expect(meter).toHaveAttribute('data-unread');
    expect(meter).not.toHaveAttribute('aria-valuenow');
    expect(meter).toHaveAttribute('aria-valuetext', 'usage unknown');
  }
  expect(rows().every(item => within(item).getByText('Unknown') && within(item).getByText('share unknown'))).toBe(true);
});

it('draws one ranked row per pool from the shares the API built, with the split of new work', async () => {
  stubSurfaceFetch({ routes: { [PATH]: { pace: { v: 1, asOf: new Date().toISOString(), pools: [{ pool: 'claude', projectedPercent: 6, hoursLeft: 50, recommendedSlots: 4 }], shares: fourPools() } } } });
  render(<UsagePace />);
  expect(await screen.findByText('Next job goes to Claude.')).toBeVisible();
  expect(rows().map(item => item.getAttribute('data-pool'))).toEqual(['claude', 'codex-personal', 'gemini', 'zai']);
  expect(rows().map(item => item.getAttribute('data-state'))).toEqual(['wasting', 'starving', 'unknown', 'unknown']);
  expect(rows().map(item => item.hasAttribute('data-next'))).toEqual([true, false, false, false]);

  const claude = row('claude');
  expect(within(claude).getByText('Send work here')).toBeVisible();
  expect(claude.querySelector('[data-figure]')).toHaveTextContent('100% of new work');
  expect(claude.querySelector('[data-facts]')).toHaveTextContent('99% left · resets in 50 h · 6% used by the reset at this burn · suggested running slots 4');
  expect(claude.querySelector('svg[data-provider="claude"]')).not.toBeNull();
  const bar = within(claude).getByRole('meter', { name: 'Claude used' });
  expect(bar).toHaveAttribute('aria-valuenow', '1');
  expect(bar).toHaveAttribute('aria-valuetext', '1% used, 6% by the reset at this burn, 94% left unused');
  expect([...bar.querySelectorAll('i')].map(part => [part.getAttribute('data-part'), part.style.width])).toEqual([['used', '1%'], ['more', '5%'], ['unused', '94%']]);

  // A pool that runs dry before its reset takes no ordinary work: amber bar to the end, nothing left unused.
  const codex = row('codex-personal');
  expect(within(codex).getByText('Top priority only')).toBeVisible();
  expect(codex.querySelector('[data-figure]')).toHaveTextContent('no ordinary work');
  expect(codex.querySelector('[data-facts]')).toHaveTextContent('3% left · runs dry in 3 h · resets in 72 h · suggested running slots unknown');
  const dry = within(codex).getByRole('meter', { name: 'Codex personal used' });
  expect(dry).toHaveAttribute('data-ending', 'dry');
  expect(dry).toHaveAttribute('aria-valuetext', '97% used, runs dry before the reset');
  expect([...dry.querySelectorAll('i')].map(part => part.getAttribute('data-part'))).toEqual(['used', 'more']);

  // No reading is a hatched bar with the server's reason, never 0%.
  expect(row('gemini').querySelector('[data-facts]')).toHaveTextContent('no usage reading · suggested running slots unknown');
  expect(within(row('zai')).getByRole('meter')).toHaveAttribute('data-unread');
  expect(screen.queryByText(/\b0% (used|left|of new work)/)).toBeNull();

  const split = screen.getByRole('img', { name: 'New work split: Claude 100%' });
  expect([...split.querySelectorAll('i')].map(part => [part.getAttribute('data-pool'), part.style.width])).toEqual([['claude', '100%']]);
  expect(document.querySelector('[data-pace-key]')).toHaveTextContent('Strip: how new work is splitused so farmore by the reset at this burnleft unused at the resetSame data: phm fleet pools.');
  expect(document.querySelector('[data-pace-note]')).toBeNull();
  expect(screen.getByText(/seconds? ago/).closest('time')).toHaveAttribute('datetime');
});

it('reads a report older than two minutes as unknown, keeping every pool on the page', async () => {
  const asOf = new Date(Date.now() - 5 * 60_000).toISOString();
  stubSurfaceFetch({ routes: { [PATH]: { pace: { v: 1, asOf, pools: [{ pool: 'claude', projectedPercent: 6, hoursLeft: 50, recommendedSlots: 4 }], shares: fourPools() } } } });
  render(<UsagePace />);
  expect(await screen.findByText('Where to send work: unknown.')).toBeVisible();
  expect(document.querySelector('[data-pace-note]')).toHaveTextContent('The scheduler last reported 5 minutes ago. A report older than two minutes is not read as current.');
  expect(screen.getByRole('region', { name: 'Usage pace' })).toHaveAttribute('data-pace', 'stale');
  expect(rows().map(item => item.querySelector('[data-facts]')!.textContent)).toEqual(Array(4).fill('no current scheduler report · suggested running slots unknown'));
  expect(screen.getAllByRole('meter').every(meter => meter.hasAttribute('data-unread'))).toBe(true);
  expect(document.querySelector('[data-split]')).toBeNull();
  expect(document.querySelector('[data-pace-key]')).toBeNull();
  expect(screen.queryByText('Send work here')).toBeNull();
});

it('says why when the server has no such read, and waits in words before the first answer', async () => {
  stubSurfaceFetch({ routes: { [PATH]: null } });
  render(<UsagePace />);
  expect(screen.getByText('Reading the scheduler report…')).toHaveAttribute('aria-busy', 'true');
  expect(screen.queryByRole('list', { name: 'Where to send work' })).toBeNull();
  expect(await screen.findByText('Where to send work: unknown.')).toBeVisible();
  expect(document.querySelector('[data-pace-note]')).toHaveTextContent(`This server does not expose ${PATH} yet, so this panel has no source.`);
  expect(screen.getByRole('region', { name: 'Usage pace' })).toHaveAttribute('data-pace', 'none');
  expect(rows().map(item => item.querySelector('[data-facts]')!.textContent)).toEqual(Array(4).fill('no scheduler report · suggested running slots unknown'));
  expect(screen.queryByRole('status')).toBeNull();
});
