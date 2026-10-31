import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { UpdateNowButton } from './UpdateNowButton.js';
import { applySelfUpdate } from './update-apply-client.js';
import type { UpdateServerStatus } from './update-status-queries.js';

vi.mock('../../../components/primitives/Toast.js', () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock('./update-apply-client.js', () => ({ applySelfUpdate: vi.fn() }));
const status: UpdateServerStatus = { v: 1, sourceState: 'healthy', installedVersion: null, headSha: null, headAt: null, originSha: null, branch: 'master', behind: 3, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: null, uptimeSeconds: null, canFastForward: true };
beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true); });

it('shows ordered steps and the failed note after an apply', async () => {
  vi.mocked(applySelfUpdate).mockResolvedValue({ kind: 'failed', reason: 'Install failed', steps: [
    { name: 'status', ok: true, ms: 100, note: null }, { name: 'fetch', ok: true, ms: 1200, note: null },
    { name: 'ahead', ok: true, ms: 2000, note: 'not shown' }, { name: 'update', ok: false, ms: 125000, note: 'npm install exited 1 (tail…) ' },
  ] });
  render(<UpdateNowButton status={status} onDone={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Update now' }));
  const list = await screen.findByRole('list', { name: 'Update steps' });
  const rows = within(list).getAllByRole('listitem');
  expect(rows).toHaveLength(4);
  expect(rows[1]).toHaveTextContent('Fetch · ok · 1.2s');
  expect(rows[2]).toHaveTextContent('Ahead check · ok · 2s');
  expect(rows[3]).toHaveTextContent('Update · failed · 2m 05s');
  expect(rows[3]).toHaveTextContent('npm install exited 1 (tail…)');
  expect(screen.queryByText('not shown')).not.toBeInTheDocument();
});
it('does not show a list when the build cannot apply updates', async () => {
  vi.mocked(applySelfUpdate).mockResolvedValue({ kind: 'not-in-build' });
  render(<UpdateNowButton status={status} onDone={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Update now' }));
  expect(await screen.findByText(/This build cannot apply updates/)).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Update steps' })).not.toBeInTheDocument();
});
