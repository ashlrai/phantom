import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { MergeBacklogReadV1 } from '../../../../core/fleet/merge-backlog-read.js';
import { mergeBacklogQuery } from '../fleet-merges/merge-backlog-queries.js';
import { fleetSupplyQuery } from '../fleet-supply/fleet-supply-queries.js';
import type { LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { DropJobSheet } from './DropJobSheet.js';
import { laneHoldsQuery } from './queue-holds-model.js';

const backlog: MergeBacklogReadV1 = {
  v: 1, repo: 'fake/repo', generatedAt: '', source: 'ok',
  counts: { mergeState: {}, actions: { merge: 0, recut: 0, refresh: 0, wait: 0, none: 0 } },
  hotFiles: [{ path: 'src/cli/fleet.ts', dirtyPrs: 8, openPrs: 8 }],
  items: Array.from({ length: 8 }, (_, i) => ({ number: 100 + i, files: ['src/cli/fleet.ts'], mergeStateStatus: 'DIRTY', title: '', headRef: '', updatedAt: null, isDraft: false, job: null, classification: { class: 'conflicted', work: 'refix', reason: 'fake' }, suggestedAction: 'recut' })),
};
const row: LaneTargetsV1['lanes'][number] = { lane: 'codex-personal', target: 16, floor: 0, ceiling: 16, held: true, heldUntil: '2099-01-01T20:02:00', heldReason: 'autobackoff', lastChange: null, changedBy: null };
const holds: LaneTargetsV1 = { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [row, { ...row, lane: 'devin', target: 4, held: false, heldUntil: null, heldReason: null }] };
const supply = { lanes: [{ lane: 'codex-personal', running: 16, queued: 14 }, { lane: 'devin', running: 2, queued: 0 }] };
beforeEach(() => {
  sessionStorage.clear(); evictAll();
  vi.spyOn(mergeBacklogQuery, 'fetch').mockResolvedValue(backlog);
  vi.spyOn(laneHoldsQuery, 'fetch').mockResolvedValue(holds);
  vi.spyOn(fleetSupplyQuery, 'fetch').mockResolvedValue(supply);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('warns about collisions and holds without blocking Write, and updates after edits', async () => {
  render(<DropJobSheet open onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Update src/cli/fleet.ts carefully' } });
  expect(screen.getByRole('button', { name: 'Write' })).toBeEnabled();
  expect(await screen.findByText(/src\/cli\/fleet.ts is in 8 open PRs \(#100, #101, #102, #103, #104, …\)/)).toBeInTheDocument();
  expect(await screen.findByText('codex-personal is held until 20:02 (autobackoff); devin has 2 free slots')).toBeInTheDocument();
  const list = screen.getByRole('list', { name: 'Preflight' });
  expect(screen.getByRole('button', { name: 'Drop anyway' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Lane'), { target: { value: 'devin' } });
  expect(within(list).queryByText(/is held/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Update src/new.ts carefully' } });
  await waitFor(() => expect(screen.queryByRole('list', { name: 'Preflight' })).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Write' })).toBeEnabled();
});
it('shows hot-file conflict counts and arms Drop anyway', async () => {
  render(<DropJobSheet open onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Update src/cli/fleet.ts carefully' } });
  expect(await screen.findByText('src/cli/fleet.ts is in 8 conflicting PRs (8 open)')).toBeInTheDocument();
  expect(screen.getByLabelText('I will keep edits to these files to one hunk')).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Drop anyway' })).toBeEnabled();
});
it('restores the Write label once the one-hunk pledge is ticked', async () => {
  render(<DropJobSheet open onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Update src/cli/fleet.ts carefully' } });
  const pledge = await screen.findByLabelText('I will keep edits to these files to one hunk');
  expect(screen.getByRole('button', { name: 'Drop anyway' })).toBeEnabled();
  fireEvent.click(pledge);
  expect(screen.getByRole('button', { name: 'Write' })).toBeEnabled();
});
it('hides failed reads and leaves validation in control', async () => {
  vi.mocked(mergeBacklogQuery.fetch).mockRejectedValue(new Error('unavailable'));
  vi.mocked(laneHoldsQuery.fetch).mockRejectedValue(new Error('unavailable'));
  render(<DropJobSheet open onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Update src/cli/fleet.ts carefully' } });
  await waitFor(() => expect(mergeBacklogQuery.fetch).toHaveBeenCalled());
  expect(screen.queryByRole('list', { name: 'Preflight' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Id'), { target: { value: 'x' } });
  expect(screen.getByRole('button', { name: 'Write' })).toBeDisabled();
});
it('reports a full lane and its best available alternative', async () => {
  vi.mocked(laneHoldsQuery.fetch).mockResolvedValue({ ...holds, lanes: holds.lanes.map(lane => ({ ...lane, held: false })) });
  render(<DropJobSheet open onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Create src/new.ts carefully' } });
  expect(await screen.findByText('codex-personal: 16 of 16 running, 14 waiting; devin has 2 free slots')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Write' })).toBeEnabled();
});
