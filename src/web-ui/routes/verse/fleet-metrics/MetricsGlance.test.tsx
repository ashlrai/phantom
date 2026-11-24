import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMetrics } from '../../../../core/fleet/metrics-glance.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { MetricsGlance } from './MetricsGlance.js';

const DIR = resolve(process.cwd(), 'test/fixtures/metrics-glance');
const NOW = Date.parse('2026-11-17T12:00:00Z');
/** The same fixture fleets as test/metrics-glance.test.ts, through the same builder the API uses. */
const report = (name: string | null) => buildMetrics({ now: NOW, hours: 24,
  status: name ? JSON.parse(readFileSync(resolve(DIR, `${name}.status.json`), 'utf8')) : null,
  ledger: name ? readFileSync(resolve(DIR, 'jobs.jsonl'), 'utf8') : null });
const tile = (label: string) => screen.getByText(label).parentElement!.textContent;
let viewport: ViewportMock | null = null;
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; });

describe.each([['desktop width', 1440], ['390 px', 390]])('Metrics at %s', (_name, width) => {
  it('shows four big numbers, the lane table and a spend-down bar per pool for a healthy fleet', () => {
    viewport = mockViewport(width);
    render(<MetricsGlance report={report('healthy')} capacity={{ claude: '3 / 8' }} />);
    expect(tile('Merged per hour')).toBe('Merged per hour0.171 h 2 · 6 h 0.5 · 24 h 0.17');
    expect(tile('Median merge time')).toBe('Median merge time4m 30spublish to merge, last 24 hours');
    expect(tile('Empty rate')).toBe('Empty rate20%no lane over half empty');
    expect(tile('Pools at risk')).toBe('Pools at risk06 unknown');
    expect(screen.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Lane', 'Jobs', 'Merged', 'Empty', 'Merge rate', 'Running / target']);
    expect(within(screen.getByRole('row', { name: /^claude/ })).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['20', '12', '11%', '67%', '3 / 8']);
    expect(within(screen.getByRole('row', { name: /^codex-personal/ })).getAllByRole('cell').at(-1)!.textContent).toBe('unknown');
    expect(screen.getByText('Merge rate by tier: work 75% · frontier 67%')).toBeTruthy();
    const meter = screen.getByRole('meter', { name: 'claude used' });
    expect(meter.getAttribute('aria-valuenow')).toBe('40');
    expect(meter.getAttribute('aria-valuetext')).toBe('40% used · 24 h to reset · 0% projected unused · waste risk low');
    expect(screen.getAllByRole('meter')).toHaveLength(2);
    expect(within(screen.getByRole('list', { name: 'Spend-down by pool' })).getAllByRole('listitem')).toHaveLength(8);
    expect(screen.getAllByText('unknown: reading missing').length).toBe(6);
  });

  it('marks a lane over half empty and a pool at risk in words, not colour alone', () => {
    viewport = mockViewport(width);
    render(<MetricsGlance report={report('empty-lane')} />);
    expect(tile('Empty rate')).toBe('Empty rate20%over half empty: devin');
    expect(tile('Pools at risk')).toBe('Pools at risk1codex-personal · 6 unknown');
    const devin = screen.getByRole('row', { name: /^devin/ });
    expect(devin.getAttribute('data-empty-high')).toBe('true');
    expect(within(devin).getAllByRole('cell')[2]!.textContent).toBe('60% (over half)');
    expect(screen.getByRole('row', { name: /^claude/ }).getAttribute('data-empty-high')).toBeNull();
    const risky = screen.getByRole('meter', { name: 'codex-personal used' }).closest('li')!;
    expect(risky.getAttribute('data-risk')).toBe('true');
    expect(risky.textContent).toContain('30% used · 10 h to reset · 50% projected unused · waste risk high');
  });

  it('shows stale and missing sources as unknown, never zero', () => {
    viewport = mockViewport(width);
    const stale = render(<MetricsGlance report={report('stale-usage')} />);
    expect(tile('Pools at risk')).toBe('Pools at riskunknown8 unknown');
    expect(screen.queryAllByRole('meter')).toHaveLength(0);
    expect(screen.getAllByText('unknown: reading stale')).toHaveLength(2);
    expect(screen.getByRole('row', { name: /^claude/ })).toBeTruthy();
    stale.unmount();
    for (const missing of [report(null), undefined]) {
      const view = render(<MetricsGlance report={missing} />);
      expect(tile('Merged per hour')).toBe('Merged per hourunknown1 h unknown · 6 h unknown · 24 h unknown');
      expect(tile('Median merge time')).toContain('unknown');
      expect(tile('Empty rate')).toBe('Empty rateunknownlanes unknown');
      expect(screen.getByText('Lanes: unknown')).toBeTruthy();
      expect(screen.queryByRole('table')).toBeNull();
      expect(view.container.textContent).not.toMatch(/\b0\b/);
      view.unmount();
    }
  });
});
