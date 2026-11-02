import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, getQuerySnapshot } from '../../../data/cache.js';
import { Composer, type ComposerProps } from '../Composer.js';
import { CLAUDE_SEAT } from '../fixtures.test-support.js';

const path = '/api/verse/fleet/control/lanes';
const row = { lane: 'devin', target: 10, floor: 0, ceiling: 20, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };
const snapshot = (target: number) => ({ v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', lanes: [{ ...row, target }] });

function setup(refusal?: { status: number; body: object }) {
  let target = 10;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === path) {
      if (init?.method === 'POST') {
        if (refusal) return Response.json(refusal.body, { status: refusal.status });
        target = (JSON.parse(String(init.body)) as { target: number }).target;
      }
      return Response.json(snapshot(target));
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  const props: ComposerProps = {
    seats: [CLAUDE_SEAT], seat: { seatId: 'claude-main', model: 'claude-opus-5' }, engine: 'claude',
    running: false, disabled: false, locked: false, onSend: vi.fn(), onStop: vi.fn(), onSeatChange: vi.fn(),
  };
  render(<Composer {...props} />);
  const box = screen.getByRole('textbox', { name: 'Message' });
  const submit = (text: string) => { fireEvent.change(box, { target: { value: text } }); fireEvent.keyDown(box, { key: 'Enter' }); };
  const posts = () => fetcher.mock.calls.filter(([url, init]) => String(url) === path && init?.method === 'POST');
  return { box, fetcher, posts, props, submit };
}

beforeEach(() => { evictAll(); localStorage.clear(); setMutationToken('fixture-token'); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it('posts a lane target and refreshes the lane and runs queries', async () => {
  const { box, posts, props, submit, fetcher } = setup();
  submit('/lane devin 12');
  await screen.findByText('devin target 10 → 12');
  expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ lane: 'devin', target: 12 });
  expect(box).toHaveValue('');
  expect(props.onSend).not.toHaveBeenCalled();
  await waitFor(() => expect(getQuerySnapshot('verse-fleet-lane-targets').data).toEqual(snapshot(12)));
  expect(fetcher.mock.calls.some(([url]) => String(url) === '/api/verse/fleet/runs')).toBe(true);
});

it('shows a refusal and keeps the draft', async () => {
  const { box, props, submit } = setup({ status: 422, body: { error: 'Target is held.' } });
  submit('/lane devin 12');
  await screen.findByText('Target is held.');
  expect(box).toHaveValue('/lane devin 12');
  expect(props.onSend).not.toHaveBeenCalled();
});

it('requires a second submit to set zero and resets confirmation after an edit', async () => {
  const { box, posts, submit } = setup();
  submit('/lane devin 0');
  expect(screen.getByText('Press Enter again to set devin to 0')).toBeInTheDocument();
  expect(posts()).toHaveLength(0);
  fireEvent.change(box, { target: { value: '/lane devin 1' } });
  fireEvent.change(box, { target: { value: '/lane devin 0' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(posts()).toHaveLength(0);
  fireEvent.keyDown(box, { key: 'Enter' });
  await screen.findByText('devin target 10 → 0');
  expect(posts()).toHaveLength(1);
});

it('keeps an invalid lane command in the composer', async () => {
  const { box, posts, props, submit } = setup();
  submit('/lane Codex 2');
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid lane name');
  expect(box).toHaveValue('/lane Codex 2');
  expect(posts()).toHaveLength(0);
  expect(props.onSend).not.toHaveBeenCalled();
});
