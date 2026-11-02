import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetMergesPane } from './FleetMergesPane.js';
import { readMerges } from './fleet-merges-model.js';
import { mergesMarkdown } from './merges-markdown.js';

const fixture = { mergesLastHour: { count: 2, items: [
  { repo: 'org/repo', number: 1, title: 'RQ-ONE' }, { repo: 'org/repo', number: 2, title: 'RQ-TWO' },
] }, publishesLastHour: [
  { job: 'RQ-TWO', lane: 'codex', at: '2026-10-31T10:53:00Z', url: 'https://github.com/org/repo/pull/2' },
  { job: 'RQ-WAIT', lane: 'codex', at: '2026-10-31T10:50:00Z' },
], sources: { merges: 'healthy' } };
beforeEach(() => { evictAll(); vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('copies the formatted markdown', async () => {
  const now = Date.parse('2026-10-31T11:05:00Z');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  render(<FleetMergesPane {...({ visible: true } as PaneProps)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy merges as Markdown' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(mergesMarkdown(readMerges(fixture), now)));
  expect(await screen.findByText('Copied')).toHaveAttribute('role', 'status');
});

it('reports clipboard failure', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error()) } });
  render(<FleetMergesPane {...({ visible: true } as PaneProps)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy merges as Markdown' }));
  expect(await screen.findByText('Copy failed')).toHaveAttribute('role', 'status');
});
