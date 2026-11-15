import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postFleetInterjection } from '../composer/fleet-interject.js';
import { IdeaSteer } from './IdeaSteer.js';

vi.mock('../composer/fleet-interject.js', () => ({ postFleetInterjection: vi.fn() }));

const ok = { at: '2026-11-09 08:00', outcome: 'accepted' } as const;
beforeEach(() => { vi.mocked(postFleetInterjection).mockReset(); });

describe('IdeaSteer', () => {
  it('posts the exact line once, disables while pending, then shows the label', async () => {
    let resolve!: (v: typeof ok) => void;
    vi.mocked(postFleetInterjection).mockReturnValue(new Promise(r => { resolve = r; }));
    render(<IdeaSteer idea={{ key: 'k1', title: 'Add retries' }} repo="phantom" />);
    fireEvent.click(screen.getByRole('button', { name: 'Do next' }));
    expect(screen.getByRole('button', { name: 'Do next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await act(async () => { resolve(ok); });
    expect(await screen.findByText('Sent: do next · just now')).toBeInTheDocument();
    expect(postFleetInterjection).toHaveBeenCalledTimes(1);
    expect(postFleetInterjection).toHaveBeenCalledWith('[idea:phantom] Do next: Add retries');
  });
  it('shows the alert and no label when the post rejects', async () => {
    vi.mocked(postFleetInterjection).mockRejectedValue(new Error('inbox locked'));
    render(<IdeaSteer idea={{ key: 'k2', title: 'Other' }} repo="phantom" />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('inbox locked');
    expect(screen.queryByText(/Sent:/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeEnabled();
  });
  it('sends the note on Enter and closes the box', async () => {
    vi.mocked(postFleetInterjection).mockResolvedValue(ok);
    render(<IdeaSteer idea={{ key: 'k3', title: 'Ship it' }} repo="phantom" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    const input = screen.getByLabelText('Note for idea: Ship it');
    fireEvent.change(input, { target: { value: 'this week' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Sent: do next · just now')).toBeInTheDocument();
    expect(postFleetInterjection).toHaveBeenCalledWith('[idea:phantom] Do next: Ship it · this week');
    expect(screen.queryByLabelText('Note for idea: Ship it')).toBeNull();
  });
  it('closes the note on Escape without sending', () => {
    render(<IdeaSteer idea={{ key: 'k4', title: 'Ship it' }} repo="phantom" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.keyDown(screen.getByLabelText('Note for idea: Ship it'), { key: 'Escape' });
    expect(screen.queryByLabelText('Note for idea: Ship it')).toBeNull();
    expect(postFleetInterjection).not.toHaveBeenCalled();
  });
});
