import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { FleetCapacityPane } from './FleetCapacityPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Lane = { lane: string; running: number; target: number; queued: number; held: boolean };
const now = Date.now();
const SAMPLES = 7;
// Seven samples five minutes apart. codex-personal fills one more slot each sample; devin is absent from the third.
function history(over: (index: number) => Partial<{ workers: number | null; leaders: number | null; paused: boolean | null }> = () => ({})) {
  return {
    v: 1, generatedAt: new Date(now).toISOString(), from: new Date(now - 60 * 60_000).toISOString(), to: new Date(now).toISOString(), sourceState: 'healthy', dropped: 0,
    samples: Array.from({ length: SAMPLES }, (_, index) => {
      const lanes: Lane[] = [
        { lane: 'alpha', running: 2, target: 2, queued: 0, held: false },
        { lane: 'codex-personal', running: 10 + index, target: 24, queued: 8 - index, held: false },
      ];
      if (index !== 2) lanes.push({ lane: 'devin', running: 1, target: 4, queued: 0, held: index >= 5 });
      return { at: new Date(now - (30 - index * 5) * 60_000).toISOString(), workers: 12 + index, leaders: 2, paused: false, ...over(index), lanes };
    }),
  };
}
const stub = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).startsWith('/api/verse/runs-history?') ? Response.json(body) : Response.json({}, { status: 404 })));
const slider = (name: string) => screen.findByRole('slider', { name });
const card = (lane: string) => screen.getByRole('button', { name: `Open ${lane} in Lanes` }).closest('li')!;
const focus = (element: HTMLElement) => act(() => { element.focus(); });
// jsdom lays nothing out, so the plot is given a width, and it builds pointer events without clientX.
function pointAt(element: HTMLElement, share: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 0, width: 200, height: 56, right: 300, bottom: 56, x: 100, y: 0, toJSON: () => ({}) });
  fireEvent(element, new MouseEvent('pointermove', { bubbles: true, clientX: 100 + share * 200 }));
}

it('reads nothing until a chart is pointed at or focused', async () => {
  stub(history());
  render(<FleetCapacityPane visible />);
  const scrub = await slider('codex-personal samples');
  expect(scrub).toHaveAttribute('aria-valuemin', '1');
  expect(scrub).toHaveAttribute('aria-valuemax', String(SAMPLES));
  expect(scrub).toHaveAttribute('aria-valuenow', String(SAMPLES));
  expect(scrub.getAttribute('aria-valuetext')).toMatch(/^Sample 7 of 7, .*: 16 of 24 running, 2 queued$/);
  expect(screen.queryByTestId('fleet-moment')).toBeNull();
  expect(document.querySelector('[data-rule="picked"]')).toBeNull();
  expect(within(card('codex-personal')).getByText('top edge 24 slots')).toBeInTheDocument();
  expect(screen.getByText(/Point at a chart, or focus it and use the arrow keys/)).toBeInTheDocument();
});

it('marks the sample pointed at on every lane, the strip and the worker chart', async () => {
  stub(history());
  render(<FleetCapacityPane visible />);
  pointAt(await slider('codex-personal samples'), 0.5);
  // Half way across seven evenly spaced samples is the fourth.
  expect(screen.getByTestId('fleet-moment')).toHaveTextContent('16 of 30 slots running across 3 lanes, 5 queued');
  expect(within(card('codex-personal')).getByText('13 of 24 running, 5 queued')).toBeInTheDocument();
  expect(within(card('alpha')).getByText('2 of 2 running, 0 queued')).toBeInTheDocument();
  expect(within(card('devin')).getByText('1 of 4 running, 0 queued')).toBeInTheDocument();
  expect(within(card('codex-personal')).queryByText('top edge 24 slots')).toBeNull();
  expect(card('codex-personal').querySelector('figcaption')).toHaveAttribute('data-reading', '4');
  // Three lanes, the strip and the worker chart.
  expect(document.querySelectorAll('[data-rule="picked"]')).toHaveLength(5);
  expect(card('alpha').querySelector('[data-rule="picked"]')).toHaveStyle({ left: '50%' });
  expect(card('codex-personal').querySelector('[data-point="picked"]')).toHaveStyle({ left: '50%', bottom: `${13 / 24 * 100}%` });
  expect(screen.getByText('15 workers, 2 leaders')).toBeInTheDocument();
  expect(screen.queryByText(/Point at a chart/)).toBeNull();
});

it('lets go when the pointer leaves', async () => {
  stub(history());
  render(<FleetCapacityPane visible />);
  const scrub = await slider('alpha samples');
  pointAt(scrub, 0);
  expect(screen.getByTestId('fleet-moment')).toHaveTextContent('13 of 30 slots running across 3 lanes, 8 queued');
  fireEvent.pointerLeave(scrub);
  expect(screen.queryByTestId('fleet-moment')).toBeNull();
  expect(document.querySelector('[data-rule="picked"]')).toBeNull();
});

it('says a lane the sample does not name was not reported and draws it no ring', async () => {
  stub(history());
  render(<FleetCapacityPane visible />);
  const scrub = await slider('devin samples');
  await focus(scrub);
  fireEvent.keyDown(scrub, { key: 'Home' });
  fireEvent.keyDown(scrub, { key: 'ArrowRight' });
  fireEvent.keyDown(scrub, { key: 'ArrowRight' });
  expect(within(card('devin')).getByText('not reported in this sample')).toBeInTheDocument();
  expect(card('devin').querySelector('[data-rule="picked"]')).not.toBeNull();
  expect(card('devin').querySelector('[data-point="picked"]')).toBeNull();
  expect(scrub.getAttribute('aria-valuetext')).toMatch(/^Sample 3 of 7, .*: not reported in this sample$/);
  expect(screen.getByTestId('fleet-moment')).toHaveTextContent('14 of 26 slots running across 2 lanes, 6 queued');
});

it('steps through the samples from the keyboard and lets go on Esc', async () => {
  stub(history());
  render(<FleetCapacityPane visible />);
  const scrub = await slider('codex-personal samples');
  await focus(scrub);
  // Focus starts on the newest sample, where devin is held.
  expect(scrub).toHaveAttribute('aria-valuenow', '7');
  expect(screen.getByTestId('fleet-moment')).toHaveTextContent('19 of 30 slots running across 3 lanes, 2 queued, 1 lane held');
  expect(within(card('devin')).getByText('1 of 4 running, 0 queued, held')).toBeInTheDocument();
  fireEvent.keyDown(scrub, { key: 'ArrowLeft' });
  expect(scrub).toHaveAttribute('aria-valuenow', '6');
  fireEvent.keyDown(scrub, { key: 'PageDown' });
  expect(scrub).toHaveAttribute('aria-valuenow', '5');
  expect(within(card('codex-personal')).getByText('14 of 24 running, 4 queued')).toBeInTheDocument();
  fireEvent.keyDown(scrub, { key: 'Home' });
  expect(scrub).toHaveAttribute('aria-valuenow', '1');
  fireEvent.keyDown(scrub, { key: 'ArrowLeft' });
  expect(scrub).toHaveAttribute('aria-valuenow', '1');
  fireEvent.keyDown(scrub, { key: 'End' });
  expect(scrub).toHaveAttribute('aria-valuenow', '7');
  // The board's own keys and modified keys pass through.
  expect(fireEvent.keyDown(scrub, { key: '[' })).toBe(true);
  expect(fireEvent.keyDown(scrub, { key: 'ArrowLeft', metaKey: true })).toBe(true);
  expect(scrub).toHaveAttribute('aria-valuenow', '7');
  expect(fireEvent.keyDown(scrub, { key: 'ArrowLeft' })).toBe(false);
  fireEvent.keyDown(scrub, { key: 'Escape' });
  expect(screen.queryByTestId('fleet-moment')).toBeNull();
});

it('keeps the moment from one chart to the next and lets go when focus leaves the charts', async () => {
  stub(history());
  render(<FleetCapacityPane visible />);
  const first = await slider('codex-personal samples');
  const second = screen.getByRole('slider', { name: 'alpha samples' });
  await focus(first);
  fireEvent.keyDown(first, { key: 'Home' });
  await focus(second);
  expect(second).toHaveAttribute('aria-valuenow', '1');
  expect(screen.getByTestId('fleet-moment')).toHaveTextContent('13 of 30 slots running');
  // A pointer leaving another chart does not take the sample from the focused one.
  fireEvent.pointerLeave(first);
  expect(screen.getByTestId('fleet-moment')).toBeInTheDocument();
  await focus(screen.getByRole('button', { name: 'Refresh' }));
  expect(screen.queryByTestId('fleet-moment')).toBeNull();
});

it('reads the worker chart by sample and keeps a missing count unknown', async () => {
  stub(history((index) => index === 6 ? { workers: null, paused: true } : {}));
  render(<FleetCapacityPane visible />);
  const scrub = await slider('Workers and leaders samples');
  await focus(scrub);
  expect(scrub.getAttribute('aria-valuetext')).toMatch(/: workers unknown, 2 leaders$/);
  expect(screen.getByText('workers unknown, 2 leaders')).toBeInTheDocument();
  expect(screen.getByTestId('fleet-moment')).toHaveTextContent(/1 lane held, fleet paused$/);
  fireEvent.keyDown(scrub, { key: 'ArrowLeft' });
  expect(screen.getByText('17 workers, 2 leaders')).toBeInTheDocument();
});

it('lets go of the sample when the window changes', async () => {
  stub(history());
  render(<FleetCapacityPane visible />);
  pointAt(await slider('alpha samples'), 1);
  expect(screen.getByTestId('fleet-moment')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '6 h' }));
  expect(screen.queryByTestId('fleet-moment')).toBeNull();
});

it('gives a single sample no slider', async () => {
  const one = history();
  one.samples = one.samples.slice(0, 1);
  stub(one);
  render(<FleetCapacityPane visible />);
  await screen.findByRole('button', { name: 'Open alpha in Lanes' });
  expect(screen.queryByRole('slider')).toBeNull();
});
