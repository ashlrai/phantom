import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { FleetCapacityPane } from './FleetCapacityPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const now = Date.now();
function history(lanes: Array<{ lane: string; running: number; target: number; queued: number; held: boolean }>, samples = 7) {
  return {
    v: 1, generatedAt: new Date(now).toISOString(), from: new Date(now - 60 * 60_000).toISOString(), to: new Date(now).toISOString(), sourceState: 'healthy', dropped: 0,
    samples: Array.from({ length: samples }, (_, index) => ({ at: new Date(now - (30 - index * 5) * 60_000).toISOString(), workers: 1, leaders: 1, paused: false, lanes })),
  };
}
const stub = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).startsWith('/api/verse/runs-history?') ? Response.json(body) : Response.json({}, { status: 404 })));
const reading = (scope: HTMLElement, label: string) => within(scope).getByText(label).nextElementSibling;

it('leads with the fleet fill and totals for the window', async () => {
  stub(history([
    { lane: 'alpha', running: 2, target: 2, queued: 0, held: false },
    { lane: 'codex-personal', running: 18, target: 24, queued: 8, held: false },
    { lane: 'devin', running: 1, target: 4, queued: 0, held: false },
  ]));
  render(<FleetCapacityPane visible />);
  expect(await screen.findByText('Lanes filled 70% of their target slots')).toBeInTheDocument();
  const totals = screen.getByLabelText('Fleet totals');
  expect(reading(totals, 'Filled')).toHaveTextContent('70%');
  expect(reading(totals, 'Idle')).toHaveTextContent('4.5 slot-h');
  expect(reading(totals, 'Held')).toHaveTextContent('0 min');
  expect(reading(totals, 'Stalled')).toHaveTextContent('30 min');
  expect(reading(totals, 'Watched')).toHaveTextContent('30 min');
  expect(within(totals).getByText('of the last 24 h')).toBeInTheDocument();
});

it('orders the cards by stall, then idle capacity, each with its last sample', async () => {
  stub(history([
    { lane: 'alpha', running: 2, target: 2, queued: 0, held: false },
    { lane: 'codex-personal', running: 18, target: 24, queued: 8, held: false },
    { lane: 'devin', running: 1, target: 4, queued: 0, held: true },
  ]));
  render(<FleetCapacityPane visible />);
  const buttons = await screen.findAllByRole('button', { name: /^Open .* in Lanes$/ });
  expect(buttons.map((button) => button.textContent)).toEqual(['codex-personal', 'devin', 'alpha']);
  const personal = buttons[0].closest('li')!;
  expect(personal).toHaveAttribute('data-tone', 'warning');
  expect(within(personal).getByText('75%')).toBeInTheDocument();
  expect(reading(personal, 'Last sample')).toHaveTextContent('18 of 24');
  expect(within(personal).getByText('8 queued')).toBeInTheDocument();
  expect(within(personal).getByText('top edge 24 slots')).toBeInTheDocument();
  const devin = buttons[1].closest('li')!;
  expect(devin).not.toHaveAttribute('data-tone');
  expect(within(devin).getByText('0 queued · held')).toBeInTheDocument();
  expect(reading(devin, 'Held')).toHaveTextContent('30 min');
});

it('says a lane had no target instead of a percentage', async () => {
  stub(history([{ lane: 'alpha', running: 0, target: 0, queued: 0, held: false }]));
  render(<FleetCapacityPane visible />);
  expect(await screen.findByText('No lane had a target in this window')).toBeInTheDocument();
  const card = screen.getByRole('button', { name: 'Open alpha in Lanes' }).closest('li')!;
  expect(within(card).getByText('no target')).toBeInTheDocument();
  expect(within(card).queryByText(/%/)).not.toBeInTheDocument();
  expect(reading(screen.getByLabelText('Fleet totals'), 'Filled')).toHaveTextContent('no target');
});

it('draws when the sampler watched and marks the launch gap on the same strip', async () => {
  stub(history([{ lane: 'codex-personal', running: 18, target: 24, queued: 8, held: false }]));
  render(<FleetCapacityPane visible />);
  const strip = await screen.findByLabelText('Watched 30 min of the last 24 h, 1 launch gap marked');
  expect(strip).toHaveAttribute('role', 'img');
  // The window is one hour and the samples cover its second half, so both marks start at the middle and run to the end.
  const marks = [...strip.children] as HTMLElement[];
  expect(marks).toHaveLength(2);
  for (const mark of marks) {
    expect(parseFloat(mark.style.left)).toBeCloseTo(50, 0);
    expect(parseFloat(mark.style.width)).toBeCloseTo(50, 0);
  }
  expect(screen.getByText(/· 30 min$/)).toBeInTheDocument();
});

it('draws no strip, totals or headline figure without samples', async () => {
  stub(history([], 0));
  render(<FleetCapacityPane visible />);
  expect(await screen.findByText(/No capacity history yet/)).toBeInTheDocument();
  expect(screen.queryByLabelText('Fleet totals')).not.toBeInTheDocument();
  expect(screen.queryByText(/Lanes filled/)).not.toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
