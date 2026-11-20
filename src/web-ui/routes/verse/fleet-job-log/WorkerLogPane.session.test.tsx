import { type MockInstance, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { WorkerLogPane } from './WorkerLogPane.js';

const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'missing', codex: 'missing', merges: 'missing' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [],
  workers: [{ job: 'RQ-NEW', repo: 'lexicon', lane: 'codex', tier: 'mid', ageSeconds: 60 }, { job: 'RQ-OLD', repo: 'phantom', lane: 'codex-personal', tier: 'mid', ageSeconds: 720 }],
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const details: Record<string, unknown> = {
  'RQ-OLD': { schema: 'fleet.job.v1', job: 'RQ-OLD', state: 'running', lane: 'codex-personal', tier: 'mid', model: 'gpt-6.1-terra', branch: 'codex-bridge/RQ-OLD', publish: { prUrl: 'https://github.com/example/repo/pull/1234' }, log: { source: 'live', tail: ['old line'] } },
  'RQ-NEW': { schema: 'fleet.job.v1', job: 'RQ-NEW', state: 'running', log: { source: 'live', tail: ['new line'] } },
};
let spy: MockInstance<typeof client.apiGet>;
beforeEach(() => {
  evictAll();
  spy = vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => {
    if (path === '/api/verse/fleet/runs') return runs;
    const job = /^\/api\/fleet\/job\?id=(.+)$/.exec(path)?.[1];
    return job ? details[job] ?? null : null;
  });
});
afterEach(() => { vi.restoreAllMocks(); evictAll(); });

const fact = (header: HTMLElement, label: string) => within(header).getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;

it('heads the session with its job, state and each recorded fact under a label', async () => {
  render(<WorkerLogPane visible />);
  const header = await screen.findByRole('region', { name: 'Session' });
  expect(within(header).getByRole('heading', { name: 'RQ-OLD' })).toBeInTheDocument();
  expect(within(header).getByText('running')).toBeInTheDocument();
  expect(fact(header, 'Lane')).toHaveTextContent('codex-personal');
  expect(fact(header, 'Tier')).toHaveTextContent('mid');
  expect(fact(header, 'Model')).toHaveTextContent('gpt-6.1-terra');
  // The detail carries no repo; it comes from the running-worker row.
  expect(fact(header, 'Repo')).toHaveTextContent('phantom');
  expect(fact(header, 'Branch')).toHaveTextContent('codex-bridge/RQ-OLD');
  expect(within(fact(header, 'Pull request')).getByRole('link', { name: 'PR #1234' })).toHaveAttribute('href', 'https://github.com/example/repo/pull/1234');
  // No launch time was recorded: it reads unknown, never an invented age.
  expect(fact(header, 'Launched')).toHaveTextContent('unknown');
  expect(fact(header, 'Launched')).toHaveAttribute('data-unknown');
});

it('labels facts the detail does not hold as unknown and a missing pull request as none recorded', async () => {
  render(<WorkerLogPane visible />);
  await screen.findByText('old line');
  fireEvent.change(screen.getByRole('combobox', { name: 'Worker' }), { target: { value: 'RQ-NEW' } });
  await screen.findByText('new line');
  const header = screen.getByRole('region', { name: 'Session' });
  expect(within(header).getByRole('heading', { name: 'RQ-NEW' })).toBeInTheDocument();
  for (const label of ['Lane', 'Tier', 'Model', 'Launched', 'Branch']) expect(fact(header, label)).toHaveTextContent('unknown');
  expect(fact(header, 'Repo')).toHaveTextContent('lexicon');
  expect(fact(header, 'Pull request')).toHaveTextContent('none recorded');
  expect(within(header).queryByRole('link')).toBeNull();
});

it('steps to the next and previous session with the buttons and with ] and [', async () => {
  render(<WorkerLogPane visible />);
  await screen.findByText('old line');
  const group = screen.getByRole('group', { name: 'Step through sessions' });
  // Oldest first, like the Worker picker.
  expect(group).toHaveTextContent('1 of 2');
  fireEvent.click(within(group).getByRole('button', { name: 'Next session' }));
  expect(await screen.findByText('new line')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Worker' })).toHaveValue('RQ-NEW');
  expect(group).toHaveTextContent('2 of 2');
  fireEvent.keyDown(screen.getByRole('log'), { key: '[' });
  expect(await screen.findByText('old line')).toBeInTheDocument();
  fireEvent.keyDown(screen.getByLabelText('Worker log'), { key: ']' });
  expect(await screen.findByText('new line')).toBeInTheDocument();
  expect(spy).toHaveBeenCalledWith('/api/fleet/job?id=RQ-NEW', undefined);
});

it('leaves [ and ] alone while typing in a field or holding a modifier', async () => {
  render(<WorkerLogPane visible />);
  await screen.findByText('old line');
  fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Find in log' }), { key: ']' });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Job ID' }), { key: ']' });
  fireEvent.keyDown(screen.getByRole('log'), { key: ']', metaKey: true });
  expect(screen.getByRole('combobox', { name: 'Worker' })).toHaveValue('RQ-OLD');
});

it('disables stepping when there is no other session to go to', async () => {
  spy.mockImplementation(async (path: string) => path === '/api/verse/fleet/runs' ? { ...runs, workers: [runs.workers[1]!] } : details['RQ-OLD']);
  render(<WorkerLogPane visible />);
  await screen.findByText('old line');
  expect(screen.getByRole('button', { name: 'Next session' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Previous session' })).toBeDisabled();
  expect(screen.getByRole('group', { name: 'Step through sessions' })).toHaveTextContent('1 of 1');
});

it('styles the header only with design tokens', () => {
  const css = readFileSync(join(process.cwd(), 'src/web-ui/routes/verse/fleet-job-log/worker-log.module.css'), 'utf8');
  const added = css.slice(css.indexOf('.step {'));
  expect(added).toContain('.facts dd[data-unknown]');
  // Every colour in the header's rules is a token, never a raw value.
  expect(added).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl/i);
});
