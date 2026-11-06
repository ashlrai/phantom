import type { AutoUpdatePolicy } from '../routes/verse/sections/update-auto-model.js';
import type { ReloadDecision } from './update-reload-model.js';

type PauseReason = 'typing' | 'hidden';
export type AutoReloadDecision =
  | { kind: 'off' }
  | { kind: 'paused'; why: PauseReason }
  | { kind: 'counting'; secondsLeft: number }
  | { kind: 'reload' };

export function decideAutoReload({ decision, policy, typing, dismissed, hidden, nowMs, armedAtMs }: {
  decision: ReloadDecision; policy: AutoUpdatePolicy; typing: boolean; dismissed: boolean;
  hidden: boolean; nowMs: number; armedAtMs: number;
}): AutoReloadDecision {
  if (!decision.show || !policy.enabled || decision.reason === 'chunk-missing' || dismissed) return { kind: 'off' };
  if (typing) return { kind: 'paused', why: 'typing' };
  if (hidden) return { kind: 'paused', why: 'hidden' };
  const secondsLeft = Math.max(0, Math.ceil((armedAtMs + 15_000 - nowMs) / 1_000));
  return secondsLeft === 0 ? { kind: 'reload' } : { kind: 'counting', secondsLeft };
}

export const countdownText = (secondsLeft: number): string => `Reloading in ${secondsLeft} s`;
export const pausedText = (why: PauseReason): string => why === 'typing' ? 'Paused while you type' : 'Paused while this page is hidden';
