/**
 * shell/preloaded.test.tsx — a preloaded component mounts without suspending
 * once its chunk is in, and `eager: false` waits for an explicit ready().
 */
import { Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { preloadedLazy } from './preloaded.js';

function Panel({ label }: { label: string }) {
  return <p>{label}</p>;
}

describe('preloadedLazy', () => {
  it('eager: false starts nothing until ready() is called', async () => {
    const load = vi.fn(async () => Panel);
    const lazyPanel = preloadedLazy(load, false);
    expect(load).not.toHaveBeenCalled();
    await lazyPanel.ready();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a loaded Slot renders in the same commit, with no fallback frame', async () => {
    const lazyPanel = preloadedLazy(async () => Panel, false);
    await lazyPanel.ready();
    render(<Suspense fallback={<p>fallback</p>}><lazyPanel.Slot label="Palette" /></Suspense>);
    // Synchronous: no findBy, no fallback ever committed.
    expect(screen.getByText('Palette')).toBeInTheDocument();
    expect(screen.queryByText('fallback')).toBeNull();
  });

  it('an unloaded Slot suspends and then shows the component', async () => {
    const lazyPanel = preloadedLazy(async () => Panel, false);
    render(<Suspense fallback={<p>fallback</p>}><lazyPanel.Slot label="Drawer" /></Suspense>);
    expect(await screen.findByText('Drawer')).toBeInTheDocument();
  });
});
