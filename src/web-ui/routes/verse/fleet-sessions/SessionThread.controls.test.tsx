/**
 * Steering a session's job from its conversation: the Pause, Resume, Stop and
 * Move row under the header (ThreadControls.tsx) and the `control` record lines
 * of fleet.session-thread.v1. The calls are the worker log's own
 * (POST /api/verse/fleet/runs/control); only the client functions are replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { JobControlReceiptV1 } from '../../../../core/fleet/job-control-types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { JOB_CONTROL_PATH } from '../fleet-job-log/job-control-action.js';
import { SessionThread } from './SessionThread.js';
import { narrowSessionThread, SESSION_THREAD_API, sourcesLine, steerable } from './session-thread-model.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const TOKEN = 'a'.repeat(64);
const PAUSE_ROW = { key: 'control:jc-0123456789ab', kind: 'control', side: 'record', label: 'Pause requested', at: ago(1), text: 'Asked from desktop. The dispatcher has not applied it yet.', format: 'plain' };

function wire(over: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
  return {
    schema: 'fleet.session-thread.v1', generatedAt: ago(0), id: 'RQ-A',
    session: { id: 'RQ-A', kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: 'RQ-A', parentId: 'leader',
      state: 'running', startedAt: ago(30), ageSeconds: 1800, lastMessageAt: ago(1), lastMessageAgeSeconds: 60, prUrl: null, computer: 'node-here',
      helpers: { below: 0, running: 0, failed: 0 }, ...session },
    summary: ['Worker on claude, fixture-model, in phantom.'],
    messages: [{ key: 'brief', kind: 'brief', side: 'other', label: 'Brief', at: null, text: 'Fix the flaky test.', format: 'markdown' }],
    sources: { sessions: 'available', activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none', output: 'none', controls: 'none' },
    gaps: [], control: null, ...over,
  };
}
const paused = () => wire({ messages: [PAUSE_ROW], control: { action: 'pause', lane: null, status: 'requested', at: ago(1) },
  sources: { sessions: 'available', activity: 'none', bus: 'none', owner: 'none', replies: 'none', orders: 'none', output: 'none', controls: 'available' } });
const lane = (name: string, running: number, target: number, held = false) =>
  ({ lane: name, running, target, queued: 0, held, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const runs = { ...fleetRunsFixture({ workers: [], lanes: [lane('claude', 1, 2), lane('codex', 0, 2), lane('held-lane', 0, 2, true), lane('full-lane', 2, 2)] }), claudeLane: null };
const receipt = (over: Partial<JobControlReceiptV1>): JobControlReceiptV1 => ({
  schema: 'fleet.job.control.v1', action: 'pause', job: 'RQ-A', lane: null, status: 'requested', reason: null,
  requestId: 'jc-0123456789ab', at: ago(0), dryRun: false, duplicate: false, ...over,
});

/** Serves the thread (whatever `body` holds when asked) and the fleet runs; returns the GET spy. */
function serve(body: { current: unknown }) {
  return vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => (path === '/api/verse/fleet/runs' ? runs : body.current));
}
const open = () => render(<SessionThread id="RQ-A" visible onBack={() => {}} />);
const row = () => screen.findByRole('group', { name: 'Steer RQ-A' });

beforeEach(() => { evictAll(); setMutationToken(TOKEN); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); clearMutationToken(); evictAll(); });

describe('steering a session from its conversation', () => {
  it('pauses in one click, says the receipt, and reads the conversation again', async () => {
    const body = { current: wire() as unknown };
    const get = serve(body);
    const post = vi.spyOn(client, 'apiPost').mockImplementation(async () => { body.current = paused(); return receipt({}); });
    open();
    const controls = await row();
    expect(within(controls).getAllByRole('button').map(button => button.textContent)).toEqual(['Pause', 'Stop', 'Move…']);
    // The lanes are not asked for until Move is opened.
    expect(get.mock.calls.map(([path]) => path)).toEqual([`${SESSION_THREAD_API}?id=RQ-A`]);
    fireEvent.click(within(controls).getByRole('button', { name: 'Pause' }));
    expect((await within(controls).findByText('Pause requested for RQ-A.')).getAttribute('data-tone')).toBe('waiting');
    expect(post).toHaveBeenCalledWith(JOB_CONTROL_PATH, { id: 'RQ-A', action: 'pause' }, TOKEN);
    // The next read carries the control file's own row: it is a line in the conversation, the chip says what stands, and Resume takes Pause's place.
    const record = await waitFor(() => { const item = screen.getByRole('list', { name: 'Conversation with RQ-A' }).querySelector('li[data-kind="control"]'); expect(item).not.toBeNull(); return item as HTMLElement; });
    expect(record.textContent).toContain('Pause requested');
    expect(record.textContent).toContain('Asked from desktop. The dispatcher has not applied it yet.');
    expect(within(controls).getByText('Pause requested', { selector: '[data-status="requested"]' })).toBeTruthy();
    expect(within(controls).queryByRole('button', { name: 'Pause' })).toBeNull();
    post.mockResolvedValue(receipt({ action: 'resume', status: 'applied' }));
    fireEvent.click(within(controls).getByRole('button', { name: 'Resume' }));
    expect((await within(controls).findByText('Resumed RQ-A.')).getAttribute('data-tone')).toBe('done');
    expect(post).toHaveBeenLastCalledWith(JOB_CONTROL_PATH, { id: 'RQ-A', action: 'resume' }, TOKEN);
  });

  it('asks before stopping, and says a refusal in the row without reading again', async () => {
    const get = serve({ current: wire() });
    const post = vi.spyOn(client, 'apiPost').mockResolvedValue(receipt({ action: 'stop', status: 'refused', reason: 'Job is not running.' }));
    open();
    const controls = await row();
    fireEvent.click(within(controls).getByRole('button', { name: 'Stop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop RQ-A?' });
    expect(post).not.toHaveBeenCalled();
    const reads = get.mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, stop' }));
    expect((await within(controls).findByText('Job is not running.')).getAttribute('data-tone')).toBe('refused');
    expect(post).toHaveBeenCalledWith(JOB_CONTROL_PATH, { id: 'RQ-A', action: 'stop' }, TOKEN);
    expect(get.mock.calls.length).toBe(reads);
  });

  it('reads the lanes once Move is opened, and moves to the lane chosen', async () => {
    const get = serve({ current: wire() });
    const post = vi.spyOn(client, 'apiPost').mockResolvedValue(receipt({ action: 'move', lane: 'codex' }));
    open();
    const controls = await row();
    fireEvent.click(within(controls).getByRole('button', { name: 'Move…' }));
    const picker = await within(controls).findByRole('combobox', { name: 'Move RQ-A to another lane' });
    expect(get.mock.calls.some(([path]) => path === '/api/verse/fleet/runs')).toBe(true);
    // Its own lane is not offered; a held or full lane is listed and cannot be chosen.
    expect(within(picker).getAllByRole('option').map(option => [option.textContent, (option as HTMLOptionElement).disabled]))
      .toEqual([['Move to…', false], ['codex', false], ['held-lane (held)', true], ['full-lane (full)', true]]);
    await waitFor(() => expect(document.activeElement).toBe(picker));
    fireEvent.change(picker, { target: { value: 'codex' } });
    expect(await within(controls).findByText('Move to codex requested for RQ-A.')).toBeTruthy();
    expect(post).toHaveBeenCalledWith(JOB_CONTROL_PATH, { id: 'RQ-A', action: 'move', lane: 'codex' }, TOKEN);
    expect(within(controls).getByRole('button', { name: 'Move…' })).toBeTruthy();
  });

  it('asks for the mutation token when none is held, then sends what was asked', async () => {
    clearMutationToken();
    serve({ current: wire() });
    const post = vi.spyOn(client, 'apiPost').mockResolvedValue(receipt({}));
    open();
    fireEvent.click(within(await row()).getByRole('button', { name: 'Pause' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlock actions' });
    expect(dialog.textContent).toContain('Steering a session requires the mutation token.');
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('says a failed call in the row and keeps the buttons', async () => {
    serve({ current: wire() });
    vi.spyOn(client, 'apiPost').mockRejectedValue(new client.ApiError('nope', 500, JOB_CONTROL_PATH, 'The control file could not be written.'));
    open();
    const controls = await row();
    fireEvent.click(within(controls).getByRole('button', { name: 'Pause' }));
    expect((await within(controls).findByRole('status')).textContent).toBe('The control file could not be written.');
    expect(within(controls).getByRole('button', { name: 'Pause' })).toHaveProperty('disabled', false);
  });

  it('draws no controls for a session with nothing to steer', async () => {
    const quiet = narrowSessionThread(wire({}, { state: 'quiet' }))!;
    expect([steerable(quiet), steerable(narrowSessionThread(wire({}, { state: 'unknown' }))!)]).toEqual(['RQ-A', 'RQ-A']);
    for (const session of [{ state: 'done' }, { state: 'failed' }, { kind: 'leader', jobId: null, state: 'idle' }, { kind: 'subagent', jobId: null }, { jobId: null }]) {
      expect(steerable(narrowSessionThread(wire({}, session))!)).toBeNull();
    }
    serve({ current: wire({}, { state: 'done' }) });
    open();
    await screen.findByLabelText('Summary');
    expect(screen.queryByRole('group', { name: 'Steer RQ-A' })).toBeNull();
  });
});

describe('control requests in the thread model', () => {
  it('reads what stands, refuses a malformed one, and names the control file under the conversation', () => {
    const read = narrowSessionThread(paused())!;
    expect(read.control).toEqual({ action: 'pause', lane: null, status: 'requested' });
    expect(sourcesLine(read)).toBe('Activity none recorded · output none recorded · bus messages none recorded · your messages none recorded · routing none recorded · control requests shown');
    for (const control of [{ action: 'launch', status: 'applied' }, { action: 'stop', status: 'refused' }, 'pause', null]) {
      expect(narrowSessionThread(wire({ control }))!.control).toBeNull();
    }
    expect(narrowSessionThread(wire({ control: { action: 'move', lane: 'codex', status: 'applied', at: ago(2) } }))!.control).toEqual({ action: 'move', lane: 'codex', status: 'applied' });
    // An older server names no control source and no standing request: the line leaves it out, and the buttons still work.
    const older = narrowSessionThread(wire({ control: undefined, sources: { activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none' } }))!;
    expect([older.control, older.sources.controls, sourcesLine(older).includes('control')]).toEqual([null, undefined, false]);
    expect(steerable(older)).toBe('RQ-A');
  });
});
