import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WindowBar, WindowBarSwatch } from './WindowBar.js';

const parts = (meter: HTMLElement) => [...meter.children].map(part => [part.getAttribute('data-part'), (part as HTMLElement).style.width || (part as HTMLElement).style.left]);
afterEach(cleanup);

describe('WindowBar', () => {
  it('draws used, more by the reset and left unused in that order, as one meter read in the caller\'s words', () => {
    render(<WindowBar label="Claude used" valueText="20% used, 10% more by its reset, 70% unused" valueNow={20.4} used={20.4} more={10} unused={69.6} ending="unused" />);
    const meter = screen.getByRole('meter', { name: 'Claude used' });
    expect(parts(meter)).toEqual([['used', '20.4%'], ['more', '10%'], ['unused', '69.6%']]);
    expect(meter).toHaveAttribute('aria-valuenow', '20');
    expect(meter).toHaveAttribute('aria-valuetext', '20% used, 10% more by its reset, 70% unused');
    expect(meter).toHaveAttribute('data-ending', 'unused');
    expect(meter).toHaveAttribute('data-size', 'bar');
    expect(meter).not.toHaveAttribute('data-unread');
  });

  it('hatches a window with no share at all: no parts, no number, no time mark, never an empty bar', () => {
    render(<WindowBar label="Devin used" valueText="unknown" valueNow={null} used={null} elapsed={40} />);
    const meter = screen.getByRole('meter', { name: 'Devin used' });
    expect(meter).toHaveAttribute('data-unread');
    expect(meter).not.toHaveAttribute('aria-valuenow');
    expect(meter.children).toHaveLength(0);
  });

  it('leaves the rest a plain track when only usage is known, and 0% used is a reading, not a gap', () => {
    const { rerender } = render(<WindowBar label="Z.ai used" valueText="50% used" valueNow={50} used={50} more={null} unused={null} />);
    expect(parts(screen.getByRole('meter'))).toEqual([['used', '50%']]);
    rerender(<WindowBar label="Z.ai used" valueText="0% used" valueNow={0} used={0} />);
    const meter = screen.getByRole('meter');
    expect(meter).not.toHaveAttribute('data-unread');
    expect(meter).toHaveAttribute('aria-valuenow', '0');
  });

  it('draws a split it was handed without a used share, and no outline when nothing is left over', () => {
    const { rerender } = render(<WindowBar label="Grok used by its reset" valueText="75% used by its reset, 25% left over" valueNow={75} used={null} more={75} unused={25} />);
    expect(parts(screen.getByRole('meter'))).toEqual([['more', '75%'], ['unused', '25%']]);
    rerender(<WindowBar label="Grok used" valueText="97% used, dry before its reset" valueNow={97} used={97} more={3} unused={0} ending="dry" />);
    expect(parts(screen.getByRole('meter'))).toEqual([['used', '97%'], ['more', '3%']]);
  });

  it('at edge size draws only the filled shares, and skips an empty one', () => {
    render(<WindowBar size="edge" label="Grok used" valueText="20% used" valueNow={20} used={20} more={0} unused={80} />);
    expect(parts(screen.getByRole('meter'))).toEqual([['used', '20%']]);
  });

  it('marks the time elapsed after the shares, and keeps every share inside 0 to 100', () => {
    render(<WindowBar label="Codex used" valueText="over" valueNow={130} used={130} more={-4} unused={Number.NaN} elapsed={64.3} />);
    const meter = screen.getByRole('meter');
    expect(parts(meter)).toEqual([['used', '100%'], ['more', '0%'], ['elapsed', '64.3%']]);
  });

  it('hatches the share held back at the window\'s end, after the shares and before the time mark', () => {
    const { rerender } = render(<WindowBar label="Claude weekly window" valueText="62% used; 40% kept for you" valueNow={62} used={62} kept={40} elapsed={71.4} />);
    const meter = screen.getByRole('meter');
    expect(parts(meter)).toEqual([['used', '62%'], ['kept', '40%'], ['elapsed', '71.4%']]);
    expect((meter.querySelector('[data-part="kept"]') as HTMLElement).style.left).toBe('60%');
    // Nothing held back is no band; an edge is too thin for one; no reading has nothing to hold back from.
    rerender(<WindowBar label="Claude weekly window" valueText="62% used" valueNow={62} used={62} kept={0} />);
    expect(parts(screen.getByRole('meter'))).toEqual([['used', '62%']]);
    rerender(<WindowBar size="edge" label="Claude weekly window" valueText="62% used" valueNow={62} used={62} kept={40} />);
    expect(parts(screen.getByRole('meter'))).toEqual([['used', '62%']]);
    rerender(<WindowBar label="Claude weekly window" valueText="no reading" valueNow={null} used={null} kept={40} />);
    expect(screen.getByRole('meter').children).toHaveLength(0);
  });

  it('keeps a flagged limit a full bar with no number: the ending says spent', () => {
    render(<WindowBar label="Codex weekly window" valueText="limit reached" valueNow={null} used={100} ending="spent" />);
    const meter = screen.getByRole('meter');
    expect(parts(meter)).toEqual([['used', '100%']]);
    expect(meter).toHaveAttribute('data-ending', 'spent');
    expect(meter).not.toHaveAttribute('aria-valuenow');
  });

  it('gives a key a swatch per part that says nothing itself', () => {
    const { container } = render(<span><WindowBarSwatch part="unused" />left over</span>);
    const swatch = container.querySelector('i')!;
    expect(swatch).toHaveAttribute('data-part', 'unused');
    expect(swatch).toHaveAttribute('aria-hidden', 'true');
    expect(container.textContent).toBe('left over');
  });
});
