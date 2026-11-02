import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { mergeBacklogQuery } from '../fleet-merges/merge-backlog-queries.js';
import { fleetSupplyQuery } from '../fleet-supply/fleet-supply-queries.js';
import type { LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { DropJobSheet } from './DropJobSheet.js';
import { laneHoldsQuery } from './queue-holds-model.js';

const row: LaneTargetsV1['lanes'][number] = { lane: 'codex-personal', target: 16, floor: 0, ceiling: 16, held: true, heldUntil: '2099-01-01T20:02:00', heldReason: 'autobackoff', lastChange: null, changedBy: null };
const holds: LaneTargetsV1 = { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [row, { ...row, lane: 'devin', target: 4, held: false, heldUntil: null, heldReason: null }] };
const supply = { lanes: [{ lane: 'codex-personal', running: 0, queued: 3 }, { lane: 'devin', running: 1, queued: 0 }] };
beforeEach(() => {
  sessionStorage.clear(); evictAll();
  vi.spyOn(mergeBacklogQuery, 'fetch').mockResolvedValue({ v: 1, repo: 'fake/repo', generatedAt: '', source: 'ok', counts: { mergeState: {}, actions: { merge: 0, recut: 0, refresh: 0, wait: 0, none: 0 } }, hotFiles: [], items: [] });
  vi.spyOn(laneHoldsQuery, 'fetch').mockResolvedValue(holds);
  vi.spyOn(fleetSupplyQuery, 'fetch').mockResolvedValue(supply);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('offers a one-click move off a held lane', async () => {
  render(<DropJobSheet open onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Create src/new.ts carefully' } });
  const move = await screen.findByRole('button', { name: 'Move to devin' });
  expect(screen.getByLabelText('Lane')).toHaveValue('codex-personal');
  fireEvent.click(move);
  expect(screen.getByLabelText('Lane')).toHaveValue('devin');
  expect(screen.queryByRole('button', { name: 'Move to devin' })).not.toBeInTheDocument();
});
it('keeps a blocked seed lane and focuses the move button', async () => {
  render(<DropJobSheet open onClose={() => {}} seed={{ id: 'fix-1', lane: 'codex-personal', tier: 'mid', body: 'Create src/new.ts carefully' }} />);
  const move = await screen.findByRole('button', { name: 'Move to devin' });
  expect(screen.getByLabelText('Lane')).toHaveValue('codex-personal');
  await vi.waitFor(() => expect(move).toHaveFocus());
});
