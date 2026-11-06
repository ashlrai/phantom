import { describe, expect, it } from 'vitest';
import type { AnnotatedEntry } from './inbox-ack-model.js';
import { canResend, resendPrefill } from './inbox-resend.js';

describe('canResend', () => {
  const acks: AnnotatedEntry['ack'][] = ['waiting', 'seen', 'unknown'];
  const etas: AnnotatedEntry['eta'][] = [
    { kind: 'overdue', minutes: 3 }, { kind: 'due-in', minutes: 2 }, { kind: 'unknown' },
  ];

  it('allows only waiting orders with an overdue leader pass', () => {
    for (const ack of acks) for (const eta of etas) {
      expect(canResend({ ack, eta })).toBe(ack === 'waiting' && eta.kind === 'overdue');
    }
  });
});

describe('resendPrefill', () => {
  const entry = { at: '2026-10-31 00:13', sourceLabel: 'Phantom desktop', text: 'Please check the fleet.\nThanks.' };

  it('marks the original text as a repeat with its Eastern time', () => {
    expect(resendPrefill(entry)).toBe('Repeat of my 00:13 ET order (no leader pass has read it yet): Please check the fleet.\nThanks.');
  });

  it('caps the entire prefill at 5,500 characters', () => {
    const prefill = resendPrefill({ ...entry, text: 'x'.repeat(6_000) });
    expect(prefill).toHaveLength(5_500);
    expect(prefill).toBe(`Repeat of my 00:13 ET order (no leader pass has read it yet): ${'x'.repeat(6_000)}`.slice(0, 5_500));
  });
});
