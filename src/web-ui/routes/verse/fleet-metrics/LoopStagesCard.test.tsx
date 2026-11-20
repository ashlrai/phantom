import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

it('shows a merged to released p50 when releases are supplied', () => {
  render(<LoopStagesCard report={buildLoopStages(ledger, [{ tag: 'v0', createdAt: now - 700 * 60_000 }, { tag: 'v1', createdAt: now - 600 * 60_000 + 100 * 60_000 }], now)} />);
  const released = screen.getByRole('row', { name: /^merged to released/ });
  expect(within(released).getAllByRole('cell').map(c => c.textContent)).toEqual(['45 min', '45 min', '0']);
  expect(screen.queryByText(/Merged to released: unknown/)).toBeNull();
});

it('says unknown with the reason when releases cannot be read', () => {
  render(<LoopStagesCard report={buildLoopStages(ledger, null, now, undefined, 'GitHub releases could not be read (gh is missing or not signed in)')} />);
  expect(screen.getByText(/Merged to released: unknown\. GitHub releases could not be read/)).toBeTruthy();
});

it('offers one 24 hours / 7 days control and reports the pick', () => {
  const picks: string[] = [];
  render(<LoopStagesCard report={buildLoopStages(ledger, null, now, 7 * 86_400_000)} range="7d" onWindow={w => picks.push(w)} />);
  expect(screen.getByText(/in the last 7 days\./)).toBeTruthy();
  expect(screen.getByRole('button', { name: '7 days' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '24 hours' }));
  expect(picks).toEqual(['24h']);
});
