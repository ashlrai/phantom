/** The four tiles on fixed numbers: values, unknowns, and color only where it means something; checked at 390 px. */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FleetBrief } from '../../../../core/fleet/status-brief.js';
import { BriefTilesView, briefTiles } from './BriefTiles.js';

const brief = (over: Partial<FleetBrief> = {}): FleetBrief => ({
  schema: 'fleet.brief.v1', v: 1, asOf: '2026-11-19T00:00:00.000Z',
  merged: { lastHour: 4, last24h: 31 }, medianMergeMinutes: 25, main: { green: 3, total: 3, red: [] },
  runway: { state: 'known', pool: 'fast', hoursLeft: 5, beforeReset: true }, ...over,
});

describe('BriefTiles', () => {
  it('draws the four tiles in order with plain words and opens details on tap', () => {
    const onOpen = vi.fn();
    render(<div style={{ width: 390 }}><BriefTilesView brief={brief()} onOpen={onOpen} /></div>);
    const tiles = screen.getAllByRole('button');
    expect(tiles.map(t => t.textContent)).toEqual([
      'Merged last hour431 in 24 hours',
      'Time to merge25 mintypical, last 24 hours',
      'Main branches green3 of 3repos with a passing main',
      'Plan runs out first5 hfast, before it resets',
    ]);
    expect(tiles[2]).toHaveAttribute('data-tone', 'good');
    expect(tiles[3]).toHaveAttribute('data-tone', 'bad');
    expect(tiles[0]).not.toHaveAttribute('data-tone');
    fireEvent.click(tiles[1]!);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('says unknown, in no color, when nothing could be read', () => {
    const tiles = briefTiles(null);
    expect(tiles.map(t => t.value)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(tiles.every(t => t.tone === undefined)).toBe(true);
  });

  it('turns main red and names the repo', () => {
    const [, , main] = briefTiles(brief({ main: { green: 2, total: 3, red: ['phantom'] } }));
    expect(main).toMatchObject({ value: '2 of 3', note: 'red: phantom', tone: 'bad' });
  });
});
