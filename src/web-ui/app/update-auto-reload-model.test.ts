import { describe, expect, it } from 'vitest';
import { countdownText, decideAutoReload, pausedText } from './update-auto-reload-model.js';
import type { ReloadDecision } from './update-reload-model.js';

const decision: ReloadDecision = { show: true, reason: 'server-restarted', sha: 'abc', message: 'updated' };
const base = { decision, policy: { enabled: true, quietMinutes: 10 }, typing: false, dismissed: false, hidden: false, nowMs: 1_000, armedAtMs: 1_000 };

describe('decideAutoReload', () => {
  it('stays off for a hidden banner, disabled policy, dismissed build, or missing chunk', () => {
    expect(decideAutoReload({ ...base, decision: { show: false } })).toEqual({ kind: 'off' });
    expect(decideAutoReload({ ...base, policy: { ...base.policy, enabled: false } })).toEqual({ kind: 'off' });
    expect(decideAutoReload({ ...base, dismissed: true })).toEqual({ kind: 'off' });
    expect(decideAutoReload({ ...base, decision: { ...decision, reason: 'chunk-missing' } })).toEqual({ kind: 'off' });
  });
  it('pauses for typing or a hidden document, even after the deadline', () => {
    expect(decideAutoReload({ ...base, typing: true, nowMs: 30_000 })).toEqual({ kind: 'paused', why: 'typing' });
    expect(decideAutoReload({ ...base, hidden: true, nowMs: 30_000 })).toEqual({ kind: 'paused', why: 'hidden' });
    expect(pausedText('typing')).toBe('Paused while you type');
    expect(pausedText('hidden')).toBe('Paused while this page is hidden');
  });
  it('counts the 15 second window and reloads at its deadline', () => {
    expect(decideAutoReload(base)).toEqual({ kind: 'counting', secondsLeft: 15 });
    expect(decideAutoReload({ ...base, nowMs: 3_001 })).toEqual({ kind: 'counting', secondsLeft: 13 });
    expect(decideAutoReload({ ...base, nowMs: 15_999 })).toEqual({ kind: 'counting', secondsLeft: 1 });
    expect(decideAutoReload({ ...base, nowMs: 16_000 })).toEqual({ kind: 'reload' });
    expect(decideAutoReload({ ...base, nowMs: 30_000 })).toEqual({ kind: 'reload' });
    expect(countdownText(12)).toBe('Reloading in 12 s');
    expect(decideAutoReload({ ...base, decision: { ...decision, reason: 'interface-behind' } })).toEqual({ kind: 'counting', secondsLeft: 15 });
  });
});
