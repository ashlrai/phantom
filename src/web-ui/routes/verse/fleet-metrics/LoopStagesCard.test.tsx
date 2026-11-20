import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { buildLoopStages } from '../../../../core/metrics/loop-stages.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { LoopStagesCard } from './LoopStagesCard.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const at = (minutes: number) => new Date(now - 600 * 60_000 + minutes * 60_000).toISOString();
const row = (event: string, ts: string, extra: object = {}) => JSON.stringify({ event, job: 'RQ-ONE', ts, ...extra });
const url = 'https://github.com/ashlrai/phantom/pull/12';
const ledger = [row('enqueue', at(0)), row('launch', at(40)), row('finish', at(50)), row('publish', at(52), { url }), row('outcome', at(55), { state: 'MERGED', url })].join('\n');
let viewport: ViewportMock | null = null;
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; });

it.each([['desktop width', 1440], ['390 px', 390]])('names the biggest wait and counts unknowns at %s', (_name, width) => {
  viewport = mockViewport(width);
  render(<LoopStagesCard report={buildLoopStages(ledger, null, now)} />);
  expect(screen.getByRole('heading', { name: 'Where the loop waits' })).toBeTruthy();
  expect(screen.getByText(/^Biggest wait: queued to launched, p50 40 min\./)).toBeTruthy();
  const released = screen.getByRole('row', { name: /^merged to released/ });
  expect(within(released).getAllByRole('cell').map(c => c.textContent)).toEqual(['unknown', 'unknown', '1']);
  expect(screen.getByRole('row', { name: /^queued to launched/ }).getAttribute('data-slowest')).toBe('true');
});

it('reads unknown for a missing report', () => {
  render(<LoopStagesCard report={undefined} />);
  expect(screen.getByText('Loop stages: unknown')).toBeTruthy();
});
