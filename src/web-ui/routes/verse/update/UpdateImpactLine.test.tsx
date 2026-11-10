import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { UpdateStatusRow } from '../sections/UpdateStatusRow.js';

vi.mock('../../../data/hooks.js', () => ({
  useQuery: (query: { key: string }) => query.key === 'verse-fleet-workers'
    ? { status: 'success', data: { workers: [{}, {}], sources: { workers: 'healthy' } } }
    : { status: 'success', data: { behind: 1, canFastForward: true, dirty: false } },
  useRefetch: () => () => {}, useRefresh: () => () => {},
}));
afterEach(cleanup);
it('renders the fleet impact before the update action', () => {
  render(<ToastProvider><UpdateStatusRow /></ToastProvider>);
  const line = screen.getByText('2 fleet jobs running. Installing restarts only the app; jobs keep running.');
  expect(line.compareDocumentPosition(screen.getByRole('button', { name: 'Update now' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
