import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetOutcomesPane } from './FleetOutcomesPane.js';

vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));

beforeEach(() => {
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    v: 1, state: 'current', feedback: { sourceState: 'healthy', cases: [
      { caseId: 'RQ-PHX-EXAMPLE31', outcome: 'failed', lane: 'codex-personal', failureKind: 'test failure', prNumber: 1234 },
      { caseId: 'RQ-PHX-MERGED31', outcome: 'producer-succeeded' },
      { caseId: 'h:0000000000000001:0000000000000002:0000000000000003:0000000000000004', outcome: 'failed' },
    ] },
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('offers an order for a wasted job and opens the interject dialog with its details', async () => {
  render(<FleetOutcomesPane {...({ visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps)} />);
  const cases = await screen.findByRole('list', { name: 'Cases' });
  const buttons = within(cases).getAllByRole('button', { name: /^Order recut/ });
  expect(buttons).toHaveLength(1);
  expect(buttons[0]).toHaveAccessibleName('Order recut of RQ-PHX-EXAMPLE31');
  fireEvent.click(buttons[0]!);
  expect(openInterjectDialog).toHaveBeenCalledExactlyOnceWith({
    prefill: 'Recut RQ-PHX-EXAMPLE31 (codex-personal): test failure — Failed. PR #1234. Inherit with git fetch origin pull/1234/head.',
  });
  expect(screen.queryByRole('region', { name: 'Case timeline' })).not.toBeInTheDocument();
});
