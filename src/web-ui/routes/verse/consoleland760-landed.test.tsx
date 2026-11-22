import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { MasonThreadPane } from './mason-thread/MasonThreadPane.js';
import { renderMobile, stubFetch } from './mobile/mobile.test-support.js';

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearMutationToken(); evictAll(); });

it('keeps a locked desktop reply without posting and opens a separate unlock form', async () => {
  const net = stubFetch({
    'GET /api/verse/comms/mason-thread': {
      schema: 'phantom.mason.thread.v1', as_of: '2026-11-19T12:00:00.000Z',
      since: '2026-11-18T12:00:00.000Z', gaps: [], items: [],
    },
  });
  renderMobile(<MasonThreadPane />);
  const box = screen.getByRole('textbox', { name: 'Message the Leader' });
  fireEvent.change(box, { target: { value: 'Please check the desktop view.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  const dialog = await screen.findByRole('dialog', { name: 'Unlock actions' });
  expect(dialog.closest('form')).toBeNull();
  expect(box).toHaveValue('Please check the desktop view.');
  expect(net.posts()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(box).toHaveValue('Please check the desktop view.');
  expect(net.posts()).toHaveLength(0);
});
