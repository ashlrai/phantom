import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runway, type RunwaySnapshot } from '../../../../core/usage/runway.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { poolParts, poolsSummary, PoolsCard } from './PoolsCard.js';

const NAMES = [['claude', 'Claude'], ['grok', 'Grok'], ['devin', 'Devin'], ['codex-local', 'Local']] as const;
const snapshot = (pools: RunwaySnapshot['pools'], asOf: string | null = '2026-11-18T12:00:00.000Z'): RunwaySnapshot =>
  ({ schema: 'pool.runway.v1', v: 1, asOf, headline: 'Fixture', pools });
const short = runway({ pool: 'claude', usedPercent: 97, burnPerHour: 0.75, hoursToReset: 50 });
const steady = runway({ pool: 'grok', usedPercent: 20, burnPerHour: 1, hoursToReset: 10 });
const at = () => '12:00';
const runs = { v: 1, generatedAt: '', lastTick: null, paused: null, claudeLane: null, lanes: [], leaders: [], inbox: [], codexPersonal: null,
  mergesLastHour: { count: null, items: [] }, workers: [{ job: 'Build', repo: 'demo', lane: 'claude', tier: 'work', ageSeconds: 1 },
    { job: 'Other', repo: 'demo', lane: 'grok', tier: 'work', ageSeconds: 1 }] };
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('pool tile parts', () => {
  it('gives the share left as a number only when usage was measured', () => {
    expect(poolParts(short)).toEqual({ leftPercent: 3, runway: 'runs out in about 4 h', reset: 'resets in 50 h', early: true });
    expect(poolParts(steady)).toEqual({ leftPercent: 80, runway: 'runs out in about 80 h', reset: 'resets in 10 h', early: false });
    expect(poolParts(runway({ pool: 'devin', usedPercent: null, burnPerHour: null, hoursToReset: 6 })))
      .toEqual({ leftPercent: null, runway: 'runway unknown', reset: 'resets in 6 h', early: false });
    expect(poolParts(undefined)).toEqual({ leftPercent: null, runway: 'runway unknown', reset: 'reset unknown', early: false });
  });
});

describe('pools summary line', () => {
  it('names the one pool that will not last, counts the unread ones and gives the soonest reset', () => {
    expect(poolsSummary(snapshot([short, steady]), NAMES, at))
      .toEqual(['Claude will not last to its reset', '1 without a usage reading', 'Next reset: Grok in 10 h', 'Read 12:00']);
  });
  it('counts them when more than one will not last', () => {
    const grok = runway({ pool: 'grok', usedPercent: 100, burnPerHour: null, hoursToReset: 5 });
    const devin = runway({ pool: 'devin', usedPercent: 10, burnPerHour: 0, hoursToReset: 0.5 });
    expect(poolsSummary(snapshot([short, grok, devin]), NAMES, at))
      .toEqual(['2 will not last to their reset', 'Next reset: Devin in 30 min', 'Read 12:00']);
  });
  it('says every measured pool lasts only when one was measured', () => {
    expect(poolsSummary(snapshot([steady]), NAMES, at)[0]).toBe('Every measured pool lasts to its reset');
    // Local has no window, so a reading for it is not a usage reading; an unparseable or absent read time is unknown, never now.
    const local = runway({ pool: 'codex-local', usedPercent: 5, burnPerHour: 1, hoursToReset: 3 });
    expect(poolsSummary(snapshot([local], null), NAMES, at)).toEqual(['No pool has a usage reading', 'Next reset unknown', 'Read time unknown']);
    expect(poolsSummary(snapshot([], 'not a time'), NAMES).at(-1)).toBe('Read time unknown');
  });
});

describe('Pools card as a resource bar', () => {
  const show = (onOpenPools?: () => void) => {
    installFetch(({ path }) => path === '/api/usage/runway' ? json(snapshot([short, steady])) : json(runs));
    return render(<PoolsCard onOpenJob={vi.fn()} onOpenPools={onOpenPools} />);
  };
  it('draws each pool as a tile: provider mark, share left, runway and reset', async () => {
    show();
    const claude = await screen.findByRole('button', { name: 'Claude: 3% left, runs out in about 4 h, resets in 50 h' });
    expect(claude.querySelector('[data-provider-badge]')).toHaveAttribute('data-provider-badge', 'Anthropic');
    expect(within(claude).getByText('3%')).toHaveTextContent('3%left');
    expect(within(claude).getByText('runs out in about 4 h')).toBeVisible();
    expect(within(claude).getByText('resets in 50 h')).toBeVisible();
    const grok = screen.getByRole('button', { name: 'Grok: 80% left, runs out in about 80 h, resets in 10 h' });
    expect(grok.querySelector('[data-provider-badge]')).toHaveAttribute('data-provider-badge', 'xAI');
    // An unread pool says so in words and has no figure; Local has no window at all.
    const devin = screen.getByRole('button', { name: 'Devin: usage unknown, runway unknown, reset unknown' });
    expect(within(devin).getByText('usage unknown')).toHaveAttribute('data-unknown');
    expect(devin).not.toHaveTextContent('%');
    const local = screen.getByRole('button', { name: 'Local: free, limited by memory' });
    expect(local).toHaveTextContent(/free.*limited by memory/);
    expect(local).not.toHaveTextContent(/%|reset/);
    const card = within(screen.getByRole('region', { name: 'Pools' }));
    expect(card.getByText('Claude will not last to its reset')).toBeVisible();
    expect(card.getByText('5 without a usage reading')).toBeVisible();
    expect(card.getByText('Next reset: Grok in 10 h')).toBeVisible();
    expect(card.getByText(/^Read \d/)).toBeVisible();
  });
  it('lists the chosen pool\'s jobs under the bar and moves with the choice', async () => {
    show();
    const claude = await screen.findByRole('button', { name: /^Claude: 3% left/ });
    expect(screen.getByText('Choose a pool to see its running jobs.')).toBeVisible();
    expect(claude).not.toHaveAttribute('aria-controls');
    fireEvent.click(claude);
    const jobs = await screen.findByRole('region', { name: 'Claude running jobs' });
    expect(claude).toHaveAttribute('aria-controls', jobs.id);
    expect(claude.closest('li')).toHaveAttribute('data-selected', 'true');
    expect(await within(jobs).findByRole('button', { name: 'Build' })).toBeVisible();
    expect(within(jobs).getByText('Running on Claude')).toBeVisible();
    expect(screen.queryByText('Choose a pool to see its running jobs.')).toBeNull();
    const grok = screen.getByRole('button', { name: /^Grok: 80% left/ });
    fireEvent.click(grok);
    expect(claude).toHaveAttribute('aria-expanded', 'false');
    expect(claude.closest('li')).not.toHaveAttribute('data-selected');
    expect(await within(screen.getByRole('region', { name: 'Grok running jobs' })).findByRole('button', { name: 'Other' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Build' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Local: free, limited by memory' }));
    expect(await within(screen.getByRole('region', { name: 'Local running jobs' })).findByText('No running jobs.')).toBeVisible();
  });
  it('opens the Pools board only where a board can be opened', async () => {
    const phone = show();
    await screen.findByRole('button', { name: /^Claude: 3% left/ });
    expect(screen.queryByRole('button', { name: 'Open Pools' })).toBeNull();
    phone.unmount(); evictAll(); vi.unstubAllGlobals();
    const open = vi.fn();
    show(open);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Pools' }));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
