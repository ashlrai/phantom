import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { OrderStateStrip } from './OrderStateStrip.js';

vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const mk = (state: string, key: string, missing: string[] = []) => ({
  at: '2026-11-13T17:13:00.000Z', source: 'slack', key, state,
  asOf: '2026-11-13T17:14:00.000Z', evidenceSource: 'ledger', missing, pr: null,
});

it('offers a follow-up only on stuck rows and opens the dialog with the prefill', async () => {
  const b = { v: 1, asOf: '2026-11-13T17:15:00.000Z', sources: {}, orders: [
    mk('BLOCKED', '11-13 13:13', ['pr']), mk('VERIFIED', '11-13 13:14'), mk('RUNNING', '11-13 13:15'), mk('RECEIVED', 'bad-key') ] };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(b), { status: 200 })));
  render(<OrderStateStrip />);
  await waitFor(() => expect(screen.getByText('BLOCKED')).toBeInTheDocument());
  const buttons = screen.getAllByRole('button', { name: /^Follow up on your/ });
  expect(buttons).toHaveLength(1);
  buttons[0]!.click();
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: 'Follow-up on my Nov 13 13:13 order (BLOCKED; missing: pr): ' });
});
