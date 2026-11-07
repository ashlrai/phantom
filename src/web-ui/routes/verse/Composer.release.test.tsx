import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { Composer, type ComposerProps } from './Composer.js';
import { CLAUDE_SEAT } from './fixtures.test-support.js';

const path = '/api/verse/fleet/control/holds';
const row = { lane: 'codex-personal', target: 2, floor: 0, ceiling: 10, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };
const data = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', lanes: [row] };
function setup(refuse = false) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === path && init?.method === 'POST') return refuse
      ? Response.json({ code: 'manual-hold', error: 'Lane was held manually' }, { status: 422 }) : Response.json(data);
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  const props: ComposerProps = { seats: [CLAUDE_SEAT], seat: { seatId: 'claude-main', model: 'claude-opus-5' }, engine: 'claude', running: false, disabled: false, locked: false, onSend: vi.fn(), onStop: vi.fn(), onSeatChange: vi.fn() };
  render(<Composer {...props} />);
  const box = screen.getByRole('textbox', { name: 'Message' });
  const submit = (text: string) => { fireEvent.change(box, { target: { value: text } }); fireEvent.keyDown(box, { key: 'Enter' }); };
  const posts = () => fetcher.mock.calls.filter(([url, init]) => String(url) === path && init?.method === 'POST');
  return { box, posts, props, submit, fetcher };
}
beforeEach(() => { evictAll(); localStorage.clear(); setMutationToken('fixture-token'); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it('releases a hold from the composer', async () => {
  const { box, posts, props, submit, fetcher } = setup();
  submit('/release codex-personal mason order');
  await screen.findByText('Released codex-personal.');
  expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ lane: 'codex-personal', action: 'release', reason: 'mason order' });
  expect(box).toHaveValue('');
  expect(props.onSend).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/inbox'))).toBe(false);
});
it('shows a manual hold refusal and keeps the draft', async () => {
  const { box, props, submit } = setup(true);
  submit('/release codex-personal mason order');
  await screen.findByText('Lane was held manually');
  expect(box).toHaveValue('/release codex-personal mason order');
  expect(props.onSend).not.toHaveBeenCalled();
});
it('keeps malformed release commands out of chat', async () => {
  const { posts, props, submit } = setup();
  submit('/release ');
  expect(await screen.findByRole('alert')).toHaveTextContent('Use /release');
  expect(posts()).toHaveLength(0);
  expect(props.onSend).not.toHaveBeenCalled();
});
