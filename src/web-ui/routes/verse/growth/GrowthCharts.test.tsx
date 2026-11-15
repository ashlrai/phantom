import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { GrowthChartView, GrowthCharts } from './GrowthCharts.js';
import type { GrowthReport, GrowthSeries } from '../../../../core/growth/series.js';

const NOW = '2026-11-09T12:00:00.000Z';

function point(t: string, y: number | null) {
  return { t, y };
}

function row(over: Partial<GrowthSeries> & Pick<GrowthSeries, 'id' | 'label'>): GrowthSeries {
  return {
    unit: 'count',
    source: null,
    status: 'no-data-source',
    reason: 'no data source',
    need: 'missing',
    caveat: null,
    freshness: 'fresh',
    points: [],
    ...over,
  };
}

function report(): GrowthReport {
  return {
    schema: 'growth.series.v1',
    generatedAt: NOW,
    readOnly: true,
    range: '1D',
    ranges: ['1H', '1D', '1W', '1M'],
    primaryId: 'mergesPerHour',
    blindSpots: [{ id: 'growth-releases', path: 'growth.releases', freshness: 'unknown', need: 'missing' }],
    series: [
      row({
        id: 'mergesPerHour',
        label: 'Merges per hour',
        unit: 'merges_per_hour',
        source: 'metrics/jobs.jsonl',
        status: 'ready',
        reason: null,
        need: null,
        points: [point('2026-11-09T11:00:00.000Z', 1), point('2026-11-09T12:00:00.000Z', 2)],
      }),
      row({ id: 'releases', label: 'Releases' }),
    ],
  };
}

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());

describe('Growth charts', () => {
  it('draws the primary series and an explicit no-data-source tile', async () => {
    const onRange = vi.fn();
    const onFocus = vi.fn();
    const user = userEvent.setup();
    render(
      <GrowthChartView
        report={report()}
        loading={false}
        refreshing={false}
        failed={false}
        range="1D"
        focus={null}
        onRange={onRange}
        onFocus={onFocus}
      />,
    );
    expect(screen.getByRole('figure', { name: 'Merges per hour' })).toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'Merges per hour' })).toHaveTextContent('metrics/jobs.jsonl');
    const releases = screen.getByRole('button', { name: 'Releases' });
    expect(releases).toHaveTextContent('no data source');
    await user.click(screen.getByRole('button', { name: '1W' }));
    expect(onRange).toHaveBeenCalledWith('1W');
    await user.click(releases);
    expect(onFocus).toHaveBeenCalledWith('releases');
  });

  it('shows no data source on the primary chart when that series has none', () => {
    render(
      <GrowthChartView
        report={report()}
        loading={false}
        refreshing={false}
        failed={false}
        range="1D"
        focus="releases"
        onRange={() => undefined}
        onFocus={() => undefined}
      />,
    );
    expect(screen.getByRole('figure', { name: 'Releases' })).toHaveTextContent('no data source');
  });

  it('loads the same series the growth endpoint returns', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/growth': report() } });
    render(<GrowthCharts />);
    expect(await screen.findByRole('figure', { name: 'Merges per hour' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Releases' })).toHaveTextContent('no data source');
  });
});
