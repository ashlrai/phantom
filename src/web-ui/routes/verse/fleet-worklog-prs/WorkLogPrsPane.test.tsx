import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { worklog } from '../../../../core/fleet/worklog.js';
import { worklogPrs } from '../../../../core/fleet/worklog-prs.js';
import { WorkLogPrsPane } from './WorkLogPrsPane.js';

const NOW = Date.parse('2026-11-18T15:20:00Z');
const pull = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const ledger = [
  { event: 'launch', job: 'a', lane: 'work', model: 'glm', ts: '2026-11-18T14:00:00Z' },
  { event: 'publish', job: 'a', url: pull(7), title: 'Add the thing', ts: '2026-11-18T14:10:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'a', url: pull(7), ttm_s: 600, ts: '2026-11-18T14:20:00Z' },
  { event: 'publish', job: 'b', url: pull(9), ts: '2026-11-18T14:40:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'b', url: pull(9), ts: '2026-11-18T15:05:00Z' },
].map(row => JSON.stringify(row)).join('\n');
const report = (text: string) => worklogPrs(worklog(text, NOW - 24 * 3600000, NOW, { hours: 24 }));
const state = vi.hoisted(() => ({ status: 'success', data: undefined as unknown }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state, useRefetch: () => vi.fn() }));
vi.mock('../../../data/client.js', () => ({ apiGet: vi.fn() }));
const show = (data: unknown, status = 'success') => {
  state.data = data; state.status = status;
  return render(<WorkLogPrsPane {...({ visible: true } as Parameters<typeof WorkLogPrsPane>[0])} />);
};
beforeEach(() => { state.data = undefined; state.status = 'success'; vi.restoreAllMocks(); });

it('shows one line per PR newest first, unknown fields in words, and opens the picked PR with the keyboard', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  show(report(ledger));
  const rows = screen.getAllByRole('option');
  expect(rows[0]!.textContent).toContain('ashlrai/phantom #9');
  expect(rows[0]!.textContent).toContain('unknown lane · unknown model · unknown min to merge');
  expect(rows[1]!.textContent).toContain('work · glm · 10 min to merge');
  expect(screen.getAllByText(/: 1 merged/)).toHaveLength(2);
  const list = screen.getByRole('listbox');
  fireEvent.keyDown(list, { key: 'ArrowDown' });
  fireEvent.keyDown(list, { key: 'Enter' });
  expect(open).toHaveBeenCalledWith(pull(7), '_blank', 'noopener,noreferrer');
  fireEvent.click(rows[0]!);
  expect(open).toHaveBeenLastCalledWith(pull(9), '_blank', 'noopener,noreferrer');
});

it('designs loading, empty and error states', () => {
  show(undefined);
  expect(screen.getByRole('status').textContent).toContain('Reading what the fleet shipped');
  show(report(''));
  expect(screen.getByText(/No PRs merged in the last 24 hours/)).toBeTruthy();
  show({ not: 'a report' }, 'error');
  expect(screen.getAllByRole('status').at(-1)!.textContent).toContain('unknown');
});
