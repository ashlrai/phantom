import { splitRefs } from '../fleet/job-refs.js';
import type { FeedItem } from './feed-model.js';

/** A compact, single-line reference; opening the composer never sends it. */
export function feedTellText(item: FeedItem): string {
  const title = item.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  const refs = splitRefs([item.id, item.title, item.body ?? ''].join('\n'))
    .filter(segment => segment.kind !== 'text').map(segment => segment.value);
  const pull = item.href?.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  if (pull) refs.push(`#${pull[1]}`);
  const uniqueRefs = [...new Set(refs)];
  return `About feed item "${title}" (${item.kind}${uniqueRefs.length ? `, ${uniqueRefs.join(', ')}` : ''}): `;
}
