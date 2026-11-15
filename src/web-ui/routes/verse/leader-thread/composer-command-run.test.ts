import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { COMPOSER_RELEASE_REASON, commandGate, runComposerCommand, type ComposerCommandDeps } from './composer-command-run.js';

const laneTargets = (held: boolean) => ({
  v: 1, generatedAt: '2026-11-09T08:00:00Z', sourceState: 'healthy',
  lanes: [{ lane: 'codex-personal', target: 3, floor: 0, ceiling: 6, held, heldReason: null, heldUntil: null, lastChange: null, changedBy: null }],
});

function deps(overrides: Partial<ComposerCommandDeps> = {}) {
  const all = {
    pauseFleet: vi.fn(async () => {}),
    resumeFleet: vi.fn(async () => {}),
    releaseHold: vi.fn(async () => laneTargets(false)),
    holdLane: vi.fn(async () => laneTargets(true)),
    stopJob: vi.fn(async (id: string) => ({ id, pids: [11, 12], outcome: 'stopped' as const, at: '2026-11-09T08:00:00Z' })),
    openDropSheet: vi.fn(() => 'seeded' as const),
    statusNow: vi.fn(async () => 'all good'),
    postNote: vi.fn(async () => {}),
    now: () => Date.parse('2026-11-09T08:00:00Z'),
    ...overrides,
  };
  return all;
}

const actionKeys = ['pauseFleet', 'resumeFleet', 'releaseHold', 'holdLane', 'stopJob', 'openDropSheet', 'statusNow'] as const;
function onlyCalled(d: ReturnType<typeof deps>, key: (typeof actionKeys)[number]) {
  for (const other of actionKeys) expect(d[other]).toHaveBeenCalledTimes(other === key ? 1 : 0);
}

describe('runComposerCommand', () => {
  it('pauses and resumes the fleet, each followed by an inbox note', async () => {
    const pause = deps();
    expect(await runComposerCommand({ name: 'pause', arg: '' }, pause)).toBe('Paused the fleet');
    onlyCalled(pause, 'pauseFleet');
    expect(pause.postNote).toHaveBeenCalledWith('[composer] /pause: done');
    const resume = deps();
    expect(await runComposerCommand({ name: 'resume', arg: '' }, resume)).toBe('Resumed the fleet');
    onlyCalled(resume, 'resumeFleet');
    expect(resume.postNote).toHaveBeenCalledWith('[composer] /resume: done');
  });

  it('releases a lane with the composer reason', async () => {
    const d = deps();
    expect(await runComposerCommand({ name: 'release', arg: 'codex-personal' }, d)).toBe('Released codex-personal');
    onlyCalled(d, 'releaseHold');
    expect(d.releaseHold).toHaveBeenCalledWith('codex-personal', COMPOSER_RELEASE_REASON);
    expect(COMPOSER_RELEASE_REASON).toBe('released from Leader composer');
    expect(d.postNote).toHaveBeenCalledWith('[composer] /release codex-personal: done');
  });

  it('reports a release the server did not confirm, without a note', async () => {
    const d = deps({ releaseHold: vi.fn(async () => laneTargets(true)) });
    expect(await runComposerCommand({ name: 'release', arg: 'codex-personal' }, d)).toBe('/release codex-personal failed: The server did not confirm the lane release.');
    expect(d.postNote).not.toHaveBeenCalled();
  });

  it('stops a job and names the outcome', async () => {
    const d = deps();
    expect(await runComposerCommand({ name: 'stop', arg: 'RQ-PHX-ONE' }, d)).toBe('Stop RQ-PHX-ONE: stopped 2 processes');
    onlyCalled(d, 'stopJob');
    expect(d.stopJob).toHaveBeenCalledWith('RQ-PHX-ONE');
    expect(d.postNote).toHaveBeenCalledWith('[composer] /stop RQ-PHX-ONE: stopped 2 processes');
  });

  it('turns a thrown ApiError into the system line and posts no note', async () => {
    const d = deps({ pauseFleet: vi.fn(async () => { throw new ApiError('Conflict', 409, '/api/fleet/pause', 'The fleet is already paused.'); }) });
    expect(await runComposerCommand({ name: 'pause', arg: '' }, d)).toBe('/pause failed: The fleet is already paused.');
    expect(d.postNote).not.toHaveBeenCalled();
  });

  it('keeps the success line when only the inbox note fails', async () => {
    const d = deps({ postNote: vi.fn(async () => { throw new Error('inbox down'); }) });
    expect(await runComposerCommand({ name: 'resume', arg: '' }, d)).toBe('Resumed the fleet (inbox note failed: inbox down)');
  });

  it('opens the drop-job sheet prefilled and queues nothing', async () => {
    const d = deps();
    expect(await runComposerCommand({ name: 'drop', arg: 'fix the flaky test' }, d)).toMatch(/^Opened the drop-job sheet/);
    onlyCalled(d, 'openDropSheet');
    expect(d.openDropSheet).toHaveBeenCalledWith({ id: 'FIXTHEFLAKYTEST09', lane: 'codex-personal', tier: 'mid', body: 'fix the flaky test' });
    expect(d.postNote).not.toHaveBeenCalled();
    const kept = deps({ openDropSheet: vi.fn(() => 'kept' as const) });
    expect(await runComposerCommand({ name: 'drop', arg: 'x' }, kept)).toBe('You have an unsent draft; the /drop text was not applied.');
  });

  it('answers /help and a missing argument locally, calling nothing', async () => {
    const d = deps();
    expect(await runComposerCommand({ name: 'help', arg: '' }, d)).toMatch(/^Commands: \/pause/);
    expect(await runComposerCommand({ name: 'release', arg: '' }, d)).toBe('/release needs a lane: /release <lane>');
    expect(await runComposerCommand({ name: 'stop', arg: '' }, d)).toBe('/stop needs a job-id: /stop <job-id>');
    for (const key of [...actionKeys, 'postNote'] as const) expect(d[key]).not.toHaveBeenCalled();
  });
});

describe('commandGate', () => {
  it('confirms pause, resume and stop like their buttons; release needs only the hold', () => {
    expect(commandGate({ name: 'pause', arg: '' })?.confirm?.title).toBe('Pause the fleet?');
    expect(commandGate({ name: 'resume', arg: '' })?.confirm?.title).toBe('Resume the fleet?');
    expect(commandGate({ name: 'stop', arg: 'RQ-PHX-ONE' })?.confirm?.title).toBe('Stop RQ-PHX-ONE?');
    expect(commandGate({ name: 'release', arg: 'claude' })).toMatchObject({ confirm: null });
  });

  it('runs local commands and argument errors without the hold', () => {
    expect(commandGate({ name: 'help', arg: '' })).toBeNull();
    expect(commandGate({ name: 'drop', arg: 'x' })).toBeNull();
    expect(commandGate({ name: 'release', arg: '' })).toBeNull();
  });
});
