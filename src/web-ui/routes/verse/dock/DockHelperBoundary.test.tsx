import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DockHelperBoundary } from './DockHelperBoundary.js';

describe('DockHelperBoundary', () => {
  it('disables a failing helper for the mount and logs only its name', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const Broken = () => { throw new Error('/private/path'); };
    const view = render(<DockHelperBoundary name="test-helper"><Broken /></DockHelperBoundary>);

    expect(screen.getByRole('status')).toHaveTextContent('A dock helper failed and was turned off for this session.');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('[verse] dock helper failed: test-helper');
    view.rerender(<DockHelperBoundary name="test-helper"><span>Recovered</span></DockHelperBoundary>);
    expect(screen.queryByText('Recovered')).not.toBeInTheDocument();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('catches errors from a helper effect', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    function BrokenEffect() {
      useEffect(() => { throw new Error('effect failed'); }, []);
      return null;
    }
    render(<DockHelperBoundary name="effect-helper"><BrokenEffect /></DockHelperBoundary>);
    expect(screen.getByRole('status')).toHaveTextContent('A dock helper failed and was turned off for this session.');
  });

  it('renders a healthy helper normally', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<DockHelperBoundary name="healthy"><span>Healthy</span></DockHelperBoundary>);
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(warn).not.toHaveBeenCalled();
  });
});
