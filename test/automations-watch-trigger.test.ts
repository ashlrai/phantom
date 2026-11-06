import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normaliseTrigger } from '../src/core/automations/validate.js';
import { pollDue, runAutomationsTick } from '../src/core/automations/engine.js';
import { emptyCursor, saveAutomation, readAutomationState } from '../src/core/automations/store.js';
import type { AutomationV1 } from '../src/core/automations/types.js';

const trigger = {
  kind: 'watch', rrule: 'FREQ=HOURLY',
  command: ['gh', 'pr', 'view', '123', '--repo', 'ashlrai/phantom', '--json', 'state'],
  condition: { path: '$.state', equals: 'MERGED' }, repeat: false,
};

describe('watch trigger', () => {
  it('normalises a read-only JSON watch', () => {
    expect(normaliseTrigger(trigger)).toEqual(trigger);
  });
  it.each([
    { rrule: 'FREQ=MINUTELY' },
    { rrule: 'FREQ=HOURLY;BYMINUTE=0,30' },
    { command: ['gh', 'pr', 'merge', '123', '--json'] },
    { command: [...trigger.command, '--jq', '.state'] },
    { condition: { path: '$.__proto__', equals: null } },
    { condition: { path: '$.state', equals: {} } },
    { repeat: 'yes' },
  ])('rejects unsafe or invalid configuration %j', (patch) => {
    expect(() => normaliseTrigger({ ...trigger, ...patch })).toThrow();
  });
  it('enforces hourly spacing, including clock rollback and disarmed state', () => {
    const automation = { trigger: normaliseTrigger(trigger) } as AutomationV1;
    const cursor = emptyCursor();
    cursor.lastPolledAt = '2026-11-04T12:00:00Z';
    cursor.nextRunAt = '2026-11-04T12:30:00Z';
    expect(pollDue(automation, cursor, new Date('2026-11-04T12:59:00Z'))).toBe(false);
    expect(pollDue(automation, cursor, new Date('2026-11-04T11:00:00Z'))).toBe(false);
    expect(pollDue(automation, cursor, new Date('2026-11-04T13:00:00Z'))).toBe(true);
    cursor.since['watchDisarmed'] = 'true';
    expect(pollDue(automation, cursor, new Date('2026-11-05T13:00:00Z'))).toBe(false);
  });
});

 it.each([false, true])('persists matching drafts and repeat=%s across ticks', async (repeat) => {
   const home = await mkdtemp(join(tmpdir(), 'watch-test-'));
   vi.stubEnv('ASHLR_HOME', home);
   try {
     await saveAutomation({ name: 'Watch lifecycle', enabled: true, trigger: { ...trigger, repeat },
       lane: 'leader-review', repos: ['ashlrai/phantom'], instructions: 'Notify Mason',
       maxConcurrent: 5, maxPerDay: 5, queueDepth: 5, spendCapUsd: 0 });
     let now = new Date('2026-11-04T12:00:00Z');
     const gh = vi.fn(async () => ({ ok: true, stdout: '{"state":"MERGED"}', stderr: '' }));
     const deps = { now: () => now, gh, decider: null, killActive: async () => false,
       policy: async () => ({ repos: [] }) as never };
     await runAutomationsTick(deps);
     expect(gh).not.toHaveBeenCalled();
     now = new Date('2026-11-04T13:00:00Z');
     await runAutomationsTick(deps);
     let state = await readAutomationState();
     expect(state.firings).toHaveLength(1);
     expect(state.firings[0]?.state).toBe('awaiting-review');
     expect(state.firings[0]?.source.kind).toBe('watch');
     now = new Date('2026-11-04T13:30:00Z');
     await runAutomationsTick(deps);
     expect(gh).toHaveBeenCalledTimes(1);
     now = new Date('2026-11-04T14:00:00Z');
     await runAutomationsTick(deps);
     state = await readAutomationState();
     expect(gh).toHaveBeenCalledTimes(repeat ? 2 : 1);
     expect(state.firings).toHaveLength(repeat ? 2 : 1);
   } finally {
     vi.unstubAllEnvs();
     await rm(home, { recursive: true, force: true });
   }
 });
