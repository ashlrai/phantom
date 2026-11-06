import type { AnnotatedEntry } from './inbox-ack-model.js';

export function canResend(entry: Pick<AnnotatedEntry, 'ack' | 'eta'>): boolean {
  return entry.ack === 'waiting' && entry.eta.kind === 'overdue';
}

export function resendPrefill(entry: Pick<AnnotatedEntry, 'at' | 'text' | 'sourceLabel'>): string {
  return `Repeat of my ${entry.at.slice(11)} ET order (no leader pass has read it yet): ${entry.text}`.slice(0, 5_500);
}
