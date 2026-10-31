import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { BusRefs } from './BusRefs.js';
import { BusSection } from './BusSection.js';
import { resetBusMissingForTest } from './bus-query.js';
import { BOOT_CONTEXT, MobileContext } from './mobile-context.js';
import { stubFetch } from './mobile.test-support.js';

afterEach(() => { evictAll(); resetBusMissingForTest(); vi.unstubAllGlobals(); });

describe('BusRefs', () => {
  it('opens job references and links pull requests', () => {
    const onOpenJob = vi.fn();
    render(<BusRefs text="RQ-PHX-EXAMPLE31 merged as ashlrai/phantom #1234; see notes" onOpenJob={onOpenJob} />);
    const button = screen.getByRole('button', { name: 'Open worker RQ-PHX-EXAMPLE31' });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(button);
    expect(onOpenJob).toHaveBeenCalledOnce();
    expect(onOpenJob).toHaveBeenCalledWith('RQ-PHX-EXAMPLE31');
    const link = screen.getByRole('link', { name: '#1234' });
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(link).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1234');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it.each(['No references here', 'RQ-'])('keeps %s as plain text', (text) => {
    const { container } = render(<BusRefs text={text} onOpenJob={vi.fn()} />);
    expect(container).toHaveTextContent(text);
    expect(container.querySelectorAll('*')).toHaveLength(0);
  });

  it('navigates from a bus event to its worker', async () => {
    const navigate = vi.fn();
    stubFetch({ 'GET /api/verse/fleet/live/bus': {
      v: 1, hops: [], events: [{ at: '2026-10-31T11:00:00Z', kind: 'inbox', text: 'RQ-PHX-EXAMPLE31 needs review' }],
      sources: { hops: 'healthy', events: 'healthy' },
    } });
    render(<MobileContext.Provider value={{ ...BOOT_CONTEXT, navigate }}><BusSection /></MobileContext.Provider>);
    const section = await screen.findByRole('region', { name: 'Bus' });
    expect(within(section).getByText('You')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Open worker RQ-PHX-EXAMPLE31' }));
    expect(navigate).toHaveBeenCalledWith({ screen: 'worker', job: 'RQ-PHX-EXAMPLE31' });
  });
});
