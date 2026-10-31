import { sourceChip } from '../fleet/interject-ack-model.js';
import type { InboxEntry } from './fleet-inbox-model.js';

export function matchesPosted(entry: InboxEntry, postedText: string): boolean {
  const normalize = (text: string) => text.replace(/\r\n/g, '\n').trim();
  return normalize(entry.text) === normalize(postedText) && postedSourceLabel(entry.source) === 'Phantom desktop';
}

export function postedSourceLabel(source: string): string {
  return sourceChip(source);
}
