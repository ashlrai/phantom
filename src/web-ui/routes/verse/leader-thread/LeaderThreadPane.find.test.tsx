import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

beforeEach(() => {
  evictAll(); clearMutationToken();
  stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Fake apple one' }), msg({ id: 'two', text: 'Fake apple two' })] },
    '/api/verse/fleet/runs': { inbox: [] },
    '/api/verse/leader/directives': { directives: [] },
  } });
});
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

describe('conversation find', () => {
  it('finds, navigates, wraps, and clears matching rows', async () => {
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    await within(log).findByText('Fake apple one');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    const input = screen.getByRole('textbox', { name: 'Find in conversation' });
    fireEvent.change(input, { target: { value: 'apple' } });
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(log.querySelectorAll('[data-find-match="true"]')).toHaveLength(2);
    expect(log.querySelector('[data-find-current="true"]')).toHaveTextContent('Fake apple one');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'missing' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'apple' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Find in conversation' })).not.toBeInTheDocument();
    expect(log.querySelectorAll('[data-find-match="true"]')).toHaveLength(0);
  });
  it('does not open from Cmd+F in the reply', () => {
    render(<LeaderThreadPane visible />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Reply to the Leader' }), { key: 'f', metaKey: true });
    expect(screen.queryByRole('textbox', { name: 'Find in conversation' })).not.toBeInTheDocument();
  });
});
