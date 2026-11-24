import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FleetJobTailV1 } from '../../../../core/fleet/runs-job-tail.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { SessionLive } from './SessionLive.js';

const JOB = 'RQ-A';
const known = { lane: 'codex', model: null, repo: 'phantom', startedAt: null, tokens: null };
const tail = (over: Partial<FleetJobTailV1> = {}): FleetJobTailV1 => ({
  schema: 'fleet.job.tail.v1', generatedAt: '2026-11-17T10:00:00.000Z', job: JOB, status: 'live', headline: `Job ${JOB}`, message: null,
  detail: { state: 'running', lane: 'codex', tier: 'frontier', model: 'model-x', launchedAt: '2026-11-17T09:00:00.000Z', prUrl: null, repo: null, tokens: 1200 },
  controls: { available: true, reason: null },
  events: [{ ts: '2026-11-17T09:00:00.000Z', source: 'event', text: 'launch codex' }, { ts: null, source: 'log', text: 'running typecheck' }],
  truncated: false, cursor: { log: 10, ledger: 10 }, ...over,
});
function serve(value: unknown) {
  return vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => {
    if (path.startsWith('/api/fleet/job/tail')) { if (value instanceof Error) throw value; return value; }
    return { lanes: [] };
  });
}
const controls = () => within(screen.getByRole('group', { name: 'Session controls' }));
afterEach(() => { cleanup(); evictAll(); clearMutationToken(); vi.restoreAllMocks(); });

it('shows the live log pinned to its newest line, what is known, and working controls', async () => {
  const get = serve(tail());
  const post = vi.spyOn(client, 'apiPost').mockResolvedValue({ schema: 'fleet.job.control.v1', action: 'pause', job: JOB, lane: null, status: 'requested', reason: null, requestId: 'r1', at: 'now', dryRun: false, duplicate: false });
  setMutationToken('a'.repeat(64));
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 900 });
  render(<SessionLive job={JOB} local enabled known={known} />);
  const log = await screen.findByRole('log', { name: `Live log for ${JOB}` });
  expect(within(log).getByText('running typecheck')).toBeInTheDocument();
  expect(log).toHaveTextContent('[2026-11-17T09:00:00.000Z] launch codex');
  expect(log.scrollTop).toBe(900);
  expect(get.mock.calls.map(([path]) => path)).toContain(`/api/fleet/job/tail?id=${JOB}&lines=200`);
  // The tail's answer wins; the list's answer fills in; the rest reads "unknown".
  for (const fact of ['Lanecodex', 'Modelmodel-x', 'Repophantom', 'Started2026-11-17T09:00:00.000Z', 'Tokens1,200']) expect(screen.getByText((_, el) => el?.tagName === 'DIV' && el.textContent === fact)).toBeInTheDocument();
  expect(screen.getByText(`phm sessions tail ${JOB} --follow`)).toBeInTheDocument();
  fireEvent.click(controls().getByRole('button', { name: 'Pause this job' }));
  expect(await controls().findByRole('status')).toHaveTextContent(`Pause requested for ${JOB}.`);
  expect(post).toHaveBeenCalledWith('/api/verse/fleet/runs/control', { id: JOB, action: 'pause' }, expect.any(String));
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
});

it('shows the controls disabled with a plain reason when the server has no control API', async () => {
  const { controls: _none, ...older } = tail({ detail: { ...tail().detail, model: null, tokens: null } });
  serve(older);
  render(<SessionLive job={JOB} local enabled known={known} />);
  await screen.findByRole('log');
  for (const name of ['Pause this job', 'Stop this job']) expect(controls().getByRole('button', { name })).toBeDisabled();
  expect(controls().getByRole('combobox', { name: 'Move this job to another lane' })).toBeDisabled();
  expect(controls().getByRole('note')).toHaveTextContent('This Phantom server has no job control for this session.');
  expect(screen.getByText((_, el) => el?.tagName === 'DIV' && el.textContent === 'Modelunknown')).toBeInTheDocument();
  expect(screen.getByText((_, el) => el?.tagName === 'DIV' && el.textContent === 'Tokensunknown')).toBeInTheDocument();
});

it('says why a finished or unreadable session cannot be steered', async () => {
  serve(tail({ status: 'finished', message: `Job ${JOB} finished. Result: ended without publishing.`, controls: { available: false, reason: 'This session has finished, so there is nothing to pause, stop or move.' } }));
  const view = render(<SessionLive job={JOB} local enabled known={known} />);
  expect(await screen.findByText('Finished. These are its last lines.', { exact: false })).toBeInTheDocument();
  expect(controls().getByRole('note')).toHaveTextContent('This session has finished');
  view.unmount(); evictAll(); vi.restoreAllMocks();
  serve(new Error('down'));
  render(<SessionLive job={JOB} local enabled known={known} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('The live log could not be read.');
  expect(controls().getByRole('button', { name: 'Stop this job' })).toBeDisabled();
});

it('reads nothing for a session on another computer and says so', () => {
  const get = serve(tail());
  render(<SessionLive job={JOB} local={false} enabled known={known} />);
  expect(screen.getByText('Live log unknown: this session runs on another computer.')).toBeInTheDocument();
  expect(controls().getByRole('note')).toHaveTextContent('No job control: this session runs on another computer.');
  expect(controls().getByRole('button', { name: 'Pause this job' })).toBeDisabled();
  expect(get.mock.calls.some(([path]) => String(path).includes('/api/fleet/job'))).toBe(false);
});
