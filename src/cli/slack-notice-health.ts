import type { ClaimNoticeTickOutcome } from './channels-slack-claim-tick.js';

const reasons = {
  'board-unavailable': 'board-state-unknown',
  'ledger-unavailable': 'sent-ledger-unreadable',
  'bindings-unavailable': 'claim-bindings-unreadable',
  'prev-unavailable': 'prev-snapshot-unreadable',
} as const;

/** Bounded session evidence; skips do not overwrite the last substantive observation. */
export function createSlackNoticeHealth() {
  const health = {
    // completed/healthy/recovered describe the enqueue pass only.
    stage: 'durable-bus-enqueue',
    receiptKind: 'bus-note',
    slackDelivery: 'unverified',
    lastAttemptAt: null as string | null,
    status: 'unknown' as string,
    reason: 'no-observation' as string | null,
    lastTick: 'none' as string,
    blocked: 0,
    passErrors: 0,
    failedNotices: 0,
    recovery: 'unknown' as 'unknown' | 'blocked' | 'healthy' | 'recovered',
  };
  return {
    health,
    observe(tick: ClaimNoticeTickOutcome, at: string): void {
      if (!tick.ran && (tick.reason === 'interval' || tick.reason === 'in-flight')) {
        health.lastTick = tick.reason;
        return;
      }
      health.lastAttemptAt = at;
      if (!tick.ran) {
        health.lastTick = tick.reason;
        health.status = tick.reason;
        health.reason = tick.reason;
        if (tick.reason === 'pass-error') { health.passErrors++; health.recovery = 'blocked'; }
        else health.recovery = 'unknown';
        return;
      }
      if ('status' in tick && tick.status in reasons) {
        const status = tick.status as keyof typeof reasons;
        health.lastTick = status; health.status = status; health.reason = reasons[status];
        health.blocked++; health.recovery = 'blocked';
      } else if ('status' in tick && tick.status === 'dry-run') {
        health.lastTick = 'dry-run'; health.status = 'dry-run'; health.reason = 'dry-run';
        health.recovery = 'unknown';
      } else if (tick.failed > 0) {
        health.lastTick = 'completed-with-failures'; health.status = 'completed-with-failures';
        health.reason = 'notice-pass-failed'; health.failedNotices += tick.failed;
        health.recovery = 'blocked';
      } else {
        health.lastTick = 'completed'; health.status = 'completed'; health.reason = null;
        health.recovery = health.blocked + health.passErrors + health.failedNotices > 0 ? 'recovered' : 'healthy';
      }
    },
  };
}
