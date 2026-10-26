/**
 * components/motion/pulse.test.tsx — a pulse plays as a Web Animation for as
 * long as its element is mounted, never as an iteration-event-firing CSS
 * animation, and follows Settings' reduce-motion choice live.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pulse } from './pulse.js';

const RING = pulse({
  keyframes: [{ transform: 'scale(1)', opacity: 0.55 }, { transform: 'scale(2.667)', opacity: 0 }],
  duration: 1800,
  easing: 'ease-out',
  pseudoElement: '::after',
});

function Dot({ on = true }: { on?: boolean }) {
  return on ? <span data-testid="dot" ref={RING} /> : null;
}

let animate: ReturnType<typeof vi.fn>;
let cancels: Array<ReturnType<typeof vi.fn>>;
const original = Element.prototype.animate;

beforeEach(() => {
  cancels = [];
  animate = vi.fn(() => {
    const cancel = vi.fn();
    cancels.push(cancel);
    return { cancel } as unknown as Animation;
  });
  Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
});

afterEach(() => {
  // Unmount first: the motion watcher must not reach a pulse after animate is restored.
  cleanup();
  Element.prototype.animate = original;
  document.documentElement.removeAttribute('data-motion');
});

describe('pulse', () => {
  it('plays the keyframes on mount, looping, with the easing between every pair, and cancels on unmount', () => {
    const view = render(<Dot />);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, timing] = animate.mock.calls[0]!;
    expect(frames).toEqual([
      { easing: 'ease-out', transform: 'scale(1)', opacity: 0.55 },
      { easing: 'ease-out', transform: 'scale(2.667)', opacity: 0 },
    ]);
    expect(timing).toEqual({ duration: 1800, iterations: Infinity, pseudoElement: '::after' });
    expect(animate.mock.contexts[0]).toBe(view.getByTestId('dot'));

    view.rerender(<Dot on={false} />);
    expect(cancels[0]).toHaveBeenCalledTimes(1);
  });

  it('stays still under reduced motion and starts when Settings asks for full motion', async () => {
    document.documentElement.setAttribute('data-motion', 'reduce');
    render(<Dot />);
    expect(animate).not.toHaveBeenCalled();

    act(() => document.documentElement.setAttribute('data-motion', 'full'));
    await waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
  });

  it('stops a playing pulse when reduce motion is switched on', async () => {
    render(<Dot />);
    expect(animate).toHaveBeenCalledTimes(1);

    act(() => document.documentElement.setAttribute('data-motion', 'reduce'));
    await waitFor(() => expect(cancels[0]).toHaveBeenCalledTimes(1));
  });

  it('leaves the element still where Element.animate does not exist', () => {
    Element.prototype.animate = undefined as unknown as typeof Element.prototype.animate;
    expect(() => render(<Dot />).unmount()).not.toThrow();
  });
});
