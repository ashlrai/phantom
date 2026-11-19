import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let state: { status: string; data?: unknown } = { status: 'loading' };
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state, useRefetch: () => () => {} }));
import { readWhatsNew, WhatsNewPanel } from './WhatsNewPanel.js';

const wire = {
  v: 1, installed: '3.30.1', reason: null,
  headline: ['Add goals view.', 'Repair saved searches.'],
  sections: [
    { heading: 'New in the app', lines: [{ text: 'Add goals view.', count: 1, prs: [1] }] },
    { heading: 'Under the hood', lines: [{ text: 'Tests, recoveries and other internal work.', count: 4, prs: [] }] },
  ],
};
afterEach(cleanup);

describe('WhatsNewPanel', () => {
  it('shows the summary first and the headings collapsed below it', () => {
    state = { status: 'success', data: wire };
    render(<WhatsNewPanel />);
    expect(screen.getByRole('heading', { name: "What's new since 3.30.1" })).toBeTruthy();
    const summary = screen.getByText('Add goals view. Repair saved searches.');
    const first = screen.getByText('New in the app');
    expect(summary.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const details = document.querySelectorAll('details');
    expect(details).toHaveLength(2);
    expect([...details].every((item) => !item.open)).toBe(true);
    fireEvent.click(first);
    expect(details[0]!.open).toBe(true);
    expect(screen.getByText('Tests, recoveries and other internal work. (4 changes)')).toBeTruthy();
  });
  it('says unknown when the history or version is not available', () => {
    state = { status: 'success', data: { ...wire, installed: null, headline: [], sections: [], reason: 'installed-version-unknown' } };
    render(<WhatsNewPanel />);
    expect(screen.getByText(/installed version is unknown/)).toBeTruthy();
    expect(document.querySelectorAll('details')).toHaveLength(0);
  });
  it('says unknown on a failed or malformed read', () => {
    state = { status: 'error' };
    render(<WhatsNewPanel />);
    expect(screen.getByText('What changed is unknown right now.')).toBeTruthy();
    expect(readWhatsNew({ v: 2 })).toBeNull();
    expect(readWhatsNew({ ...wire, headline: [1] })).toBeNull();
  });
});
