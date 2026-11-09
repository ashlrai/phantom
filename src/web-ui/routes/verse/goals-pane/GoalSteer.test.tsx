import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postFleetInterjection } from '../composer/fleet-interject.js';
import { GoalSteer } from './GoalSteer.js';

vi.mock('../composer/fleet-interject.js', () => ({ postFleetInterjection: vi.fn() }));

const goal = { id: 'g1', objective: 'Grow the fleet' };
beforeEach(() => { vi.mocked(postFleetInterjection).mockReset(); });

describe('GoalSteer', () => {
  it('sends the tagged line once on Enter and shows Steered', async () => {
    vi.mocked(postFleetInterjection).mockResolvedValue({ at: '2026-11-09 08:00', outcome: 'accepted' });
    render(<GoalSteer goal={goal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }));
    const input = screen.getByLabelText('Steer goal: Grow the fleet');
    fireEvent.change(input, { target: { value: 'push this harder' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Steered just now')).toBeInTheDocument();
    expect(postFleetInterjection).toHaveBeenCalledTimes(1);
    expect(postFleetInterjection).toHaveBeenCalledWith('[goal:g1] Grow the fleet: push this harder');
  });
  it('shows the server message when the client rejects', async () => {
    vi.mocked(postFleetInterjection).mockRejectedValue(new Error('inbox locked'));
    render(<GoalSteer goal={{ id: 'g2', objective: 'Other' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }));
    fireEvent.change(screen.getByLabelText('Steer goal: Other'), { target: { value: 'pause' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('inbox locked');
    expect(screen.queryByText(/Steered/)).toBeNull();
  });
  it('closes on Escape and does not send empty text', () => {
    render(<GoalSteer goal={goal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Steer goal: Grow the fleet'), { key: 'Escape' });
    expect(screen.queryByLabelText('Steer goal: Grow the fleet')).toBeNull();
    expect(postFleetInterjection).not.toHaveBeenCalled();
  });
});
