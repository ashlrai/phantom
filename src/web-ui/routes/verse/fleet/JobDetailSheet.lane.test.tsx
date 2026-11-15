import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LaunchLaneNote } from './LaunchLaneNote.js';

describe('launch lane note', () => {
  it('shows one lane when they match', () => {
    render(<LaunchLaneNote requestedLane="devin" launchedLane="devin" />);
    expect(screen.getByText('Lane: devin')).toBeTruthy();
  });
  it('shows the reroute reason', () => {
    render(<LaunchLaneNote requestedLane="codex-personal" launchedLane="claude" laneReason="capacity" />);
    expect(screen.getByText('Asked: codex-personal, Ran on: claude — capacity')).toBeTruthy();
  });
  it('explains an unrecorded reason', () => {
    render(<LaunchLaneNote requestedLane="codex-personal" launchedLane="claude" />);
    expect(screen.getByText(/reason not recorded/)).toBeTruthy();
  });
  it('omits unknown lanes and shows a single known lane', () => {
    const view = render(<LaunchLaneNote />);
    expect(view.container.textContent).toBe('');
    view.rerender(<LaunchLaneNote requestedLane="devin" />);
    expect(screen.getByText('Lane: devin')).toBeTruthy();
  });
});
