/** The Models board's reading cursor: one bar of time held on every card at once, by pointer or from the keyboard. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRegistryRow } from '../../../../core/fleet/model-verify.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { ModelsPane } from './ModelsPane.js';
import { columnWhen } from './model-work-model.js';
import { WORK_NOW, workGroup, workReport } from './model-work.test-support.js';

const PATH = '/api/verse/fleet/control/models';
const reply = (id: string, provider: string): ModelRegistryRow =>
  ({ id, provider, lanes: [], verified: true, status: 'verified', source_url: 'https://docs.example.test/models', verified_on: '2026-11-05', unverified: false, stale: false, reason: null });
const registry = { schema: 'models.registry.v1', entries: [reply('opus', 'anthropic'), reply('fresh', 'openai'), reply('spare', 'openai')] };
const opus = workGroup('opus', { launched: 7, merged: 3, finished: 6, empty: 1 }, { 3: { launched: 2 }, 22: { launched: 4, merged: 1 }, 23: { launched: 1, merged: 2 } });
const fresh = workGroup('fresh', { launched: 1 }, { 23: { launched: 1 } });
// The fleet's own hours hold more than the two named models did: work under no model name is in them too.
const fleet = workGroup('fleet', {}, { 3: { launched: 2 }, 22: { launched: 9, merged: 4 }, 23: { launched: 2, merged: 2 } }).buckets;
const day = workReport([opus, fresh], { buckets: fleet });
const routes = (work: unknown) => ({ [PATH]: registry, [`${PATH}/check`]: null, '/api/verse/fleet/runs/lane-models': null, '/api/verse/fleet/runs/throughput': work });

const model = (id: string) => screen.getByRole('listitem', { name: `${id} model` });
const line = (id: string) => model(id).querySelector<HTMLElement>('[data-work]')!;
const strip = (id: string) => line(id).querySelector<HTMLElement>('[data-work-strip]')!;
const column = (id: string, index: number) => strip(id).children[index] as HTMLElement;
const heldIn = (id: string) => [...strip(id).children].findIndex(child => child.hasAttribute('data-at'));
const when = (index: number) => columnWhen({ start: opus.buckets[index]!.start, hours: 1 });
const TOTAL = 'Last 24 hours: 8 jobs launched, 3 PRs merged, 1 of 6 finished jobs empty, under 2 model names.';

async function board() {
  stubSurfaceFetch({ routes: routes(day) });
  render(<ModelsPane />);
  await screen.findByText(TOTAL);
}

beforeEach(() => { evictAll(); vi.useFakeTimers({ toFake: ['Date'], now: WORK_NOW }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Models board reading cursor', () => {
  it('holds the bar the pointer is on across every card and reads the fleet for that hour', async () => {
    await board();
    expect(strip('opus')).not.toHaveAttribute('data-cursor');
    fireEvent.mouseEnter(column('opus', 22));
    // The same hour on both cards, each with its own counts.
    expect(heldIn('opus')).toBe(22);
    expect(heldIn('fresh')).toBe(22);
    expect(within(line('opus')).getByText(`${when(22)}: 4 jobs launched, 1 PR merged`)).toBeInTheDocument();
    expect(within(line('fresh')).getByText(`${when(22)}: 0 jobs launched, 0 PRs merged`)).toBeInTheDocument();
    expect(within(line('opus')).queryByText('7 jobs launched, 3 PRs merged, 1 of 6 finished jobs empty')).toBeNull();
    // The line above the cards is the report's own hour for the whole fleet, not a sum of the cards.
    expect(screen.getByText(`${when(22)}: 9 jobs launched, 4 PRs merged across the fleet.`)).toBeInTheDocument();
    expect(screen.queryByText(TOTAL)).toBeNull();
    // A model with nothing recorded has no bar to hold and keeps its own words.
    expect(within(line('spare')).getByText('no work recorded in the last 24 hours')).toBeInTheDocument();
    expect(strip('spare')).toHaveAttribute('role', 'img');

    fireEvent.mouseLeave(strip('opus'));
    expect(heldIn('opus')).toBe(-1);
    expect(heldIn('fresh')).toBe(-1);
    expect(within(line('opus')).getByText('7 jobs launched, 3 PRs merged, 1 of 6 finished jobs empty')).toBeInTheDocument();
    expect(screen.getByText(TOTAL)).toBeInTheDocument();
  });

  it('is a slider: focus holds the newest bar, the arrows, Home and End move it and stop at the ends, Esc lets go', async () => {
    await board();
    const slider = within(model('opus')).getByRole('slider', { name: 'opus jobs launched over the last 24 hours, a bar per hour: most in one bar 4' });
    expect(slider).toHaveAttribute('aria-valuemax', '24');
    // With no bar held the slider still says the newest one, and holds nothing on screen.
    expect(slider).toHaveAttribute('aria-valuenow', '24');
    expect(slider).toHaveAttribute('aria-valuetext', `${when(23)}: 1 job launched, 2 PRs merged`);
    fireEvent.focus(slider);
    expect(heldIn('opus')).toBe(23);
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(heldIn('opus')).toBe(23);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(heldIn('fresh')).toBe(22);
    expect(slider).toHaveAttribute('aria-valuenow', '23');
    expect(slider).toHaveAttribute('aria-valuetext', `${when(22)}: 4 jobs launched, 1 PR merged`);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(heldIn('opus')).toBe(0);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(heldIn('opus')).toBe(0);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(heldIn('opus')).toBe(23);
    // A chord is not the cursor's, and neither is a letter.
    fireEvent.keyDown(slider, { key: 'ArrowLeft', metaKey: true });
    fireEvent.keyDown(slider, { key: 'j' });
    expect(heldIn('opus')).toBe(23);

    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(slider, { key: 'Escape' });
    expect(heldIn('opus')).toBe(-1);
    expect(outer).not.toHaveBeenCalled();
    // With nothing held, Escape is not taken: it reaches whatever closes the pane.
    fireEvent.keyDown(slider, { key: 'Escape' });
    expect(outer).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', outer);
  });

  it('keeps the held bar while focus moves to another card\'s row, and lets go when focus leaves the rows or the window changes', async () => {
    stubSurfaceFetch({ routes: routes(day) });
    render(<ModelsPane />);
    await screen.findByText(TOTAL);
    const a = strip('opus'), b = strip('fresh');
    fireEvent.focus(a);
    fireEvent.keyDown(a, { key: 'Home' });
    fireEvent.blur(a, { relatedTarget: b });
    fireEvent.focus(b);
    expect(heldIn('fresh')).toBe(0);
    fireEvent.blur(b, { relatedTarget: null });
    expect(heldIn('fresh')).toBe(-1);

    fireEvent.mouseEnter(column('opus', 3));
    expect(heldIn('opus')).toBe(3);
    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    expect(screen.queryByText(/across the fleet\.$/)).toBeNull();
  });
});
