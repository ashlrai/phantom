import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LibraryPane } from './LibraryPane.js';

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());

it('opens the project memory as plain text, capped at 200 lines', async () => {
  const content = Array.from({ length: 201 }, (_, index) => `line ${index + 1}`).join('\n');
  stubSurfaceFetch({ routes: {
    '/api/verse/sessions': [{ id: 's1', title: 'chat', projectPath: '/tmp/project', createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
    '/api/verse/memory': { projectPath: '/tmp/project', enabled: true, content, bytes: content.length, updatedAt: null, files: [] },
  } });
  render(<LibraryPane visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open memory preview' }));
  const preview = screen.getByLabelText('project memory preview');
  expect(preview).toHaveTextContent('line 200');
  expect(preview).not.toHaveTextContent('line 201');
  fireEvent.click(screen.getByRole('button', { name: 'Close memory preview' }));
  expect(within(document.body).queryByLabelText('project memory preview')).not.toBeInTheDocument();
});
