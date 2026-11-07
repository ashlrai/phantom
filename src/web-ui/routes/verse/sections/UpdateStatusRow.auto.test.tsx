import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { UpdateStatusRow } from './UpdateStatusRow.js';
import { readAutoUpdatePolicy } from './update-auto-model.js';
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
it('persists the Settings switch across remounts', () => {
  localStorage.clear(); vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  const view = render(<ToastProvider><UpdateStatusRow /></ToastProvider>);
  fireEvent.click(screen.getByRole('switch'));
  expect(readAutoUpdatePolicy().enabled).toBe(true);
  view.unmount(); render(<ToastProvider><UpdateStatusRow /></ToastProvider>);
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('switch'));
  expect(readAutoUpdatePolicy().enabled).toBe(false);
});
