import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { commandArgError, holdArgs, parseComposerDraft } from './composer-commands.js';
import { COMPOSER_HOLD_REASON, commandGate, runComposerCommand, type ComposerCommandDeps } from './composer-command-run.js';

const laneTargets = (held: boolean) => ({
  v: 1, generatedAt: '2026-11-09T08:00:00Z', sourceState: 'healthy',
  lanes: [{ lane: 'codex-personal', target: 3, floor: 0, ceiling: 6, held, heldReason: held ? 'held from Leader composer' : null, heldUntil: held ? '2026-11-09T08:30:00Z' : null, lastChange: null, changedBy: null }],
});

function deps(overrides: Partial<ComposerCommandDeps> = {}) {
  return {
    pauseFleet: vi.fn(async () => {}),
    resumeFleet: vi.fn(async () => {}),
    releaseHold: vi.fn(async () => laneTargets(false)),
    holdLane: vi.fn(async () => laneTargets(true)),
    stopJob: vi.fn(async (id: string) => ({ id, pids: [11, 12], outcome: 'stopped' as const, at: '2026-11-09T08:00:00Z' })),
    openDropSheet: vi.fn(() => 'seeded' as const),
    statusNow: vi.fn(async () => 'live status text'),
    postNote: vi.fn(async () => {}),
    now: () => Date.parse('2026-11-09T08:00:00Z'),
    ...overrides,
  };
}
const writeKeys = ['pauseFleet', 'resumeFleet', 'releaseHold', 'holdLane', 'stopJob', 'openDropSheet', 'postNote'] as const;

describe('/hold parsing and argument errors', () => {
  it('parses a lane and minutes together as the argument', () => {
    expect(parseComposerDraft('/hold codex-personal 30')).toEqual({ kind: 'command', name: 'hold', arg: 'codex-personal 30' });
    expect(holdArgs('codex-personal 30')).toEqual({ lane: 'codex-personal', minutes: 30 });
    expect(holdArgs('codex-personal soon')).toBeNull();
  });

  it('rejects missing, malformed and out-of-range arguments', () => {
    expect(commandArgError({ name: 'hold', arg: '' })).toBe('/hold needs a lane and minutes: /hold <lane> <minutes>');
    expect(commandArgError({ name: 'hold', arg: 'codex-personal' })).toBe('/hold takes a lane and minutes: /hold <lane> <minutes>');
    expect(commandArgError({ name: 'hold', arg: 'codex-personal 30 extra' })).toBe('/hold takes a lane and minutes: /hold <lane> <minutes>');
    expect(commandArgError({ name: 'hold', arg: 'Codex Personal 30' })).toBe('/hold takes a lane and minutes: /hold <lane> <minutes>');
    expect(commandArgError({ name: 'hold', arg: 'Codex-Personal 30' })).toMatch(/valid lane name/);
    for (const arg of ['codex-personal soon', 'codex-personal 0', 'codex-personal 1441', 'codex-personal -5', 'codex-personal 1.5']) {
      expect(commandArgError({ name: 'hold', arg })).toBe('Minutes must be a whole number from 1 to 1440.');
    }
    expect(commandArgError({ name: 'hold', arg: 'codex-personal 1' })).toBeNull();
    expect(commandArgError({ name: 'hold', arg: 'codex-personal 1440' })).toBeNull();
  });
});

describe('commandGate', () => {
  it('gates /hold on the mutation token with no confirm; /status needs nothing', () => {
    expect(commandGate({ name: 'hold', arg: 'codex-personal 30' })).toMatchObject({ confirm: null });
    expect(commandGate({ name: 'hold', arg: 'codex-personal 30' })?.reason).toMatch(/mutation token/);
    expect(commandGate({ name: 'hold', arg: 'codex-personal soon' })).toBeNull();
    expect(commandGate({ name: 'status', arg: '' })).toBeNull();
  });
});

describe('runComposerCommand', () => {
  it('holds a lane with the composer reason and posts the done note', async () => {
    const d = deps();
    expect(await runComposerCommand({ name: 'hold', arg: 'codex-personal 30' }, d)).toBe('Held codex-personal for 30 min');
    expect(d.holdLane).toHaveBeenCalledWith('codex-personal', 30, COMPOSER_HOLD_REASON);
    expect(COMPOSER_HOLD_REASON).toBe('held from Leader composer');
    expect(d.postNote).toHaveBeenCalledWith('[composer] /hold codex-personal 30: done');
    for (const key of writeKeys) if (key !== 'holdLane' && key !== 'postNote') expect(d[key]).not.toHaveBeenCalled();
  });

  it('reports a hold the server did not confirm, without a note', async () => {
    const d = deps({ holdLane: vi.fn(async () => laneTargets(false)) });
    expect(await runComposerCommand({ name: 'hold', arg: 'codex-personal 30' }, d)).toBe('/hold codex-personal 30 failed: The server did not confirm the lane hold.');
    expect(d.postNote).not.toHaveBeenCalled();
  });

  it('shows the live status text, the unavailable line, or the failure, always read-only', async () => {
    const ok = deps();
    expect(await runComposerCommand({ name: 'status', arg: '' }, ok)).toBe('live status text');
    const missing = deps({ statusNow: vi.fn(async () => null) });
    expect(await runComposerCommand({ name: 'status', arg: '' }, missing)).toBe('Status is unavailable right now.');
    const thrown = deps({ statusNow: vi.fn(async () => { throw new ApiError('Server Error', 500, '/api/verse/comms/owner-thread/status', 'status exploded'); }) });
    expect(await runComposerCommand({ name: 'status', arg: '' }, thrown)).toBe('/status failed: status exploded');
    // /status is a read: no token, no inbox note, no writes.
    for (const d of [ok, missing, thrown]) for (const key of writeKeys) expect(d[key]).not.toHaveBeenCalled();
  });
});
