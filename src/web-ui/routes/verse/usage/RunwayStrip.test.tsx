import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { projectPoolRunway } from '../../../../core/usage/runway-read.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { RunwayStrip } from './RunwayStrip.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const uia = (fields: Record<string, unknown>) => ({ use_it_all: { known: true, stale: false, ...fields } });
const snapshot = () => projectPoolRunway({ schema: 'dispatchd.status.v1', last_tick: new Date(now - 1000).toISOString(), budget: {
  claude: uia({ used_pct: 97, burn_pct_per_hour: 1.2, reset_at: at(59) }),
  zai: uia({ used_pct: 20, burn_pct_per_hour: 0.2, reset_at: at(100) }),
  gemini: uia({ used_pct: 40, reset_at: at(30) }),
} }, now);

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());

describe('Runway strip on the Usage view', () => {
  it('shows one line per pool from /api/usage/runway, starving pools first and marked STARVE', async () => {
    const { calls } = installFetch(({ path }) => path === '/api/usage/runway' ? json(snapshot()) : json({}, 404));
    render(<RunwayStrip />);
    expect(await screen.findByRole('region', { name: 'Runway' })).toBeVisible();
    const items = await screen.findAllByRole('listitem');
    expect(items.map(item => item.getAttribute('aria-label'))).toEqual(['claude STARVE', 'zai SPEND', 'codex-personal unknown', 'gemini unknown']);
    expect(items[0]).toHaveAttribute('data-state', 'starve');
    expect(within(items[0]!).getByText('97% used · empty in 3h · reset in 59h')).toBeVisible();
    expect(within(items[0]!).getByText(/frontier and high-yield work only/)).toBeVisible();
    // Unknown burn is printed as unknown, never a guessed time.
    expect(within(items[3]!).getByText('40% used · empty in unknown · reset in 30h')).toBeVisible();
    expect(within(items[3]!).getByText('unknown: no burn rate yet')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(snapshot().headline);
    expect(calls.map(call => call.path)).toContain('/api/usage/runway');
  });

  it.each([['an error', () => json({}, 500)], ['another shape', () => json({ lanes: [] })],
    ['a bad row', () => json({ ...snapshot(), pools: [{ pool: 'claude', state: 'guess', advice: '' }] })]])('says unknown on %s', async (_name, reply) => {
    installFetch(reply);
    render(<RunwayStrip />);
    expect(await screen.findByText('unknown (status unavailable)')).toBeVisible();
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});
