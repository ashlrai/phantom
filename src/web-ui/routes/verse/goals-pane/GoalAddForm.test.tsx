import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { GoalAddForm } from './GoalAddForm.js';

const goal = { id: 'g-1', objective: 'Grow the fleet', status: 'planning' };
const created = () => new Response(JSON.stringify({ schema: 'verse.goal-create.v1', status: 'created', goal }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const input = () => screen.getByLabelText('New goal objective');
const addButton = () => screen.getByRole('button', { name: 'Add' });

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

describe('GoalAddForm', () => {
  it('posts the trimmed objective, clears the input and shows Added', async () => {
    setMutationToken('fixture-token');
    const stub = stubSurfaceFetch({ routes: { '/api/goals': [] }, post: () => created() });
    render(<GoalAddForm />);
    fireEvent.change(input(), { target: { value: '  Grow the fleet  ' } });
    fireEvent.click(addButton());
    expect(await screen.findByText('Added')).toBeInTheDocument();
    expect(stub.posted).toEqual([{ url: '/api/verse/goals', body: { objective: 'Grow the fleet' } }]);
    expect((input() as HTMLInputElement).value).toBe('');
  });

  it('submits on Enter inside the input', async () => {
    setMutationToken('fixture-token');
    const stub = stubSurfaceFetch({ post: () => created() });
    const { container } = render(<GoalAddForm />);
    fireEvent.change(input(), { target: { value: 'Grow the fleet' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByText('Added')).toBeInTheDocument();
    expect(stub.posted).toHaveLength(1);
  });

  it('shows the exists sentence and clears the input', async () => {
    setMutationToken('fixture-token');
    stubSurfaceFetch({ post: () => new Response(JSON.stringify({ schema: 'verse.goal-create.v1', status: 'exists', goal }), { status: 200, headers: { 'Content-Type': 'application/json' } }) });
    render(<GoalAddForm />);
    fireEvent.change(input(), { target: { value: 'Grow the fleet' } });
    fireEvent.click(addButton());
    expect(await screen.findByText('That goal already exists')).toBeInTheDocument();
    expect((input() as HTMLInputElement).value).toBe('');
  });

  it('shows the server refusal sentence on a failed POST and keeps the input', async () => {
    setMutationToken('fixture-token');
    stubSurfaceFetch({ post: () => new Response(JSON.stringify({ error: 'The goals store is unavailable.' }), { status: 500, headers: { 'Content-Type': 'application/json' } }) });
    render(<GoalAddForm />);
    fireEvent.change(input(), { target: { value: 'Grow the fleet' } });
    fireEvent.click(addButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('The goals store is unavailable.');
    expect((input() as HTMLInputElement).value).toBe('Grow the fleet');
  });

  it('shows the mutation-lock sentence without a token and never posts', async () => {
    const stub = stubSurfaceFetch({ post: () => created() });
    render(<GoalAddForm />);
    fireEvent.change(input(), { target: { value: 'Grow the fleet' } });
    fireEvent.click(addButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Unlock actions with the mutation token before chatting.');
    expect(stub.posted).toEqual([]);
  });

  it('refuses control characters client-side without posting', async () => {
    setMutationToken('fixture-token');
    const stub = stubSurfaceFetch({ post: () => created() });
    render(<GoalAddForm />);
    fireEvent.change(input(), { target: { value: `nul${String.fromCharCode(0)}x` } });
    fireEvent.click(addButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('The objective cannot contain control characters.');
    expect(stub.posted).toEqual([]);
  });

  it('disables the button while the POST is pending, then re-enables it', async () => {
    setMutationToken('fixture-token');
    let release: ((res: Response) => void) | undefined;
    stubSurfaceFetch({ post: () => new Promise<Response>((resolve) => { release = resolve; }) });
    render(<GoalAddForm />);
    fireEvent.change(input(), { target: { value: 'Grow the fleet' } });
    fireEvent.click(addButton());
    const pending = screen.getByRole('button', { name: 'Adding…' });
    expect(pending).toBeDisabled();
    await act(async () => { release!(created()); });
    expect(await screen.findByText('Added')).toBeInTheDocument();
    // The cleared input keeps the button disabled; typing the next objective re-enables it.
    expect(addButton()).toBeDisabled();
    fireEvent.change(input(), { target: { value: 'Next goal' } });
    expect(addButton()).not.toBeDisabled();
  });
});
