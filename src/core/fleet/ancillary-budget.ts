export const ANCILLARY_OBSERVATION_BUDGET_MS = 60_000;

export type AncillarySkipReason = 'ancillary-budget' | 'phase-cancelled';

export interface AncillaryBudgetOptions {
  signal?: AbortSignal;
  deadlineAtMs?: number;
  now?: () => number;
}

export function ancillaryStopReason(opts: AncillaryBudgetOptions): AncillarySkipReason | undefined {
  if (opts.signal?.aborted) return opts.signal.reason === 'ancillary-budget' ? 'ancillary-budget' : 'phase-cancelled';
  if (opts.deadlineAtMs !== undefined && (opts.now ?? Date.now)() >= opts.deadlineAtMs) return 'ancillary-budget';
  return undefined;
}

export function createAncillaryObservationBudget(opts: {
  signal?: AbortSignal;
  budgetMs?: number;
  now?: () => number;
  onSkip: (stage: string, reason: AncillarySkipReason) => void;
}) {
  const now = opts.now ?? Date.now;
  const budgetMs = Math.max(0, opts.budgetMs ?? ANCILLARY_OBSERVATION_BUDGET_MS);
  const controller = new AbortController();
  const cancel = (): void => controller.abort('phase-cancelled');
  if (opts.signal?.aborted) cancel();
  else opts.signal?.addEventListener('abort', cancel, { once: true });
  const controls: AncillaryBudgetOptions = { signal: controller.signal, deadlineAtMs: now() + budgetMs, now };
  const timer = setTimeout(() => controller.abort('ancillary-budget'), budgetMs);
  timer.unref?.();
  return {
    async run(stage: string, run: (controls: AncillaryBudgetOptions) => unknown | Promise<unknown>): Promise<void> {
      const before = ancillaryStopReason(controls);
      if (before) { opts.onSkip(stage, before); return; }
      try {
        await run(controls);
      } finally {
        const reason = ancillaryStopReason(controls);
        if (reason) opts.onSkip(stage, reason);
      }
    },
    dispose(): void {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', cancel);
    },
  };
}
