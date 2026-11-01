import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken, setRemoteActGranted } from '../../../../data/auth-store.js';
import { isGuardOpen, resetGuard } from '../../shell/guard-store.js';
import { json, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { DropJobScreen } from './DropJobScreen.js';
import { suggestId } from './drop-job-model.js';
const path = '/api/verse/fleet/live/drop-jobs';
const remoteMutate = vi.hoisted(() => vi.fn());
vi.mock('../../../../data/remote-session.js', () => ({ remoteMutate }));
beforeEach(() => setMutationToken(TOKEN));
afterEach(() => { clearMutationToken(); setRemoteActGranted(false); resetGuard(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.head.querySelector('meta[name="ashlr-remote-gateway"]')?.remove(); });
function fill() { fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Fix: the queue!' } }); }
it('renders defaults, suggests an editable id and posts the routing header, then clears the form', async () => {
  const net = stubFetch({ [`POST ${path}`]: { status: 'written', bytes: 123 } });
  renderMobile(<DropJobScreen />);
  expect(screen.getByRole('button', { name: 'codex-personal' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'mid' })).toHaveAttribute('aria-pressed', 'true');
  fill();
  expect(screen.getByLabelText('Job id')).toHaveValue(suggestId('Fix: the queue!', Date.now()));
  fireEvent.change(screen.getByLabelText('Job id'), { target: { value: 'PHONE1101' } });
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Hand to the fleet' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Written RQ-PHX-PHONE1101.md · 123 B · ingest sweeps about every 2 min');
  expect(net.posts()[0]).toMatchObject({ url: path, headers: { 'x-ashlr-token': TOKEN }, body: { id: 'PHONE1101', lane: 'codex-personal', tier: 'mid', body: '#job repo=phantom lane=codex-personal tier=mid\n\nFix: the queue!' } });
  expect(screen.getByLabelText('Goal')).toHaveValue('');
  expect(screen.getByLabelText('Job id')).toHaveValue('');
});
it.each(['reason', 'error'])('shows the server %s verbatim and keeps the draft', async key => {
  stubFetch({ [`POST ${path}`]: () => json({ [key]: 'Not today, queue is full.' }, 507) });
  renderMobile(<DropJobScreen />); fill();
  fireEvent.click(screen.getByRole('button', { name: 'Hand to the fleet' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Not today, queue is full.');
  expect(screen.getByLabelText('Goal')).toHaveValue('Fix: the queue!');
});
it.each([403, 404])('shows the gateway deny on remote HTTP %s', async status => {
  document.head.insertAdjacentHTML('beforeend', '<meta name="ashlr-remote-gateway" content="v1">');
  setRemoteActGranted(true);
  remoteMutate.mockRejectedValue(Object.assign(new Error('denied'), { status }));
  const net = stubFetch({});
  renderMobile(<DropJobScreen />); fill();
  fireEvent.click(screen.getByRole('button', { name: 'Hand to the fleet' }));
  expect(await screen.findByRole('alert')).toHaveTextContent("This phone's gateway does not allow drop-jobs yet; it is being added");
  expect(remoteMutate).toHaveBeenCalledWith('POST', path, expect.objectContaining({ lane: 'codex-personal' }));
  expect(net.posts()).toHaveLength(0);
});
it('does not write without a held mutation token', async () => {
  clearMutationToken(); const net = stubFetch({});
  renderMobile(<DropJobScreen />); fill();
  fireEvent.click(screen.getByRole('button', { name: 'Hand to the fleet' }));
  await waitFor(() => expect(isGuardOpen()).toBe(true));
  expect(net.posts()).toHaveLength(0);
});

it('updates the routing line with lane and tier and sends remotely without a local POST', async () => {
  document.head.insertAdjacentHTML('beforeend', '<meta name="ashlr-remote-gateway" content="v1">');
  setRemoteActGranted(true);
  remoteMutate.mockResolvedValue({ status: 'written', bytes: 99 });
  const net = stubFetch({});
  renderMobile(<DropJobScreen />); fill();
  fireEvent.click(screen.getByRole('button', { name: 'devin' }));
  fireEvent.click(screen.getByRole('button', { name: 'fast' }));
  expect(screen.getByText('#job repo=phantom lane=devin tier=fast')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Hand to the fleet' }));
  expect(await screen.findByRole('status')).toHaveTextContent('99 B');
  expect(remoteMutate).toHaveBeenCalledWith('POST', path, expect.objectContaining({ lane: 'devin', tier: 'fast', body: '#job repo=phantom lane=devin tier=fast\n\nFix: the queue!' }));
  expect(net.posts()).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'devin' })).toHaveAttribute('aria-pressed', 'true');
});
