import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { buildLoopStages } from '../../../../core/metrics/loop-stages.js';
import { LoopStagesCard, stageBars } from './LoopStagesCard.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const at = (minutes: number) => new Date(now - 600 * 60_000 + minutes * 60_000).toISOString();
const row = (event: string, ts: string, extra: object = {}) => JSON.stringify({ event, job: 'RQ-ONE', ts, ...extra });
const url = 'https://github.com/ashlrai/phantom/pull/12';
const ledger = [row('enqueue', at(0)), row('launch', at(40)), row('finish', at(50)), row('publish', at(52), { url }), row('outcome', at(55), { state: 'MERGED', url })].join('\n');
afterEach(cleanup);

it('sizes each stage against the longest median and keeps a stage without one as null', () => {
  expect(stageBars([{ p50_minutes: 40 }, { p50_minutes: 10 }, { p50_minutes: null }, { p50_minutes: 0 }])).toEqual([100, 25, null, 0]);
  // No stage has a median: nothing to compare against, so no bar claims a length.
  expect(stageBars([{ p50_minutes: null }, { p50_minutes: null }])).toEqual([null, null]);
  expect(stageBars([{ p50_minutes: 0 }])).toEqual([0]);
  expect(stageBars([])).toEqual([]);
});

it('draws a bar under each stage: full for the slowest, hatched with no fill where the median is unknown', () => {
  render(<LoopStagesCard report={buildLoopStages(ledger, null, now)} />);
  const bar = (name: RegExp) => screen.getByRole('row', { name }).querySelector<HTMLElement>('[data-stage]')!;
  const slowest = bar(/^queued to launched/);
  expect(slowest.getAttribute('aria-hidden')).toBe('true');
  expect(slowest.querySelector<HTMLElement>('span')!.style.width).toBe('100%');
  // 10 minutes of work against the 40 minute wait.
  expect(bar(/^launched to finished/).querySelector<HTMLElement>('span')!.style.width).toBe('25%');
  const unknown = bar(/^merged to released/);
  expect(unknown.hasAttribute('data-unknown')).toBe(true);
  expect(unknown.querySelector('span')).toBeNull();
});

it('draws no bars when the report is missing', () => {
  const { container } = render(<LoopStagesCard report={undefined} />);
  expect(container.querySelector('[data-stage]')).toBeNull();
});
