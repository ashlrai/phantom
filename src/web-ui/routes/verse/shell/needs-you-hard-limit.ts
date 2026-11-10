/**
 * Pure model for the Needs-you drawer's hard-limit chip (t1637u): which asks
 * truly need Mason (secrets, money, outside send, deletes data) and which
 * Phantom can clear itself. Classification is core's classifyNeedsItem; this
 * file only names the result for a row.
 *
 * Two deliberate mappings beyond the four named limits:
 *   - 'authority' (signing, standing approvals, grants) stays "Only you":
 *     release trust is reserved for the owner, so the chip never calls it
 *     clearable.
 *   - 'unrecognized' reads "Phantom can clear". Core keeps such text for Mason
 *     when it auto-resolves; here the chip is a label only (no action), and
 *     nearly every drawer item (PRs, run reviews) is unrecognized prose.
 */
import { classifyNeedsItem, type HardLimit } from '../../../../core/fleet/needs-mason-triage.js';

export type HardLimitLabel =
  | { kind: 'only-you'; limit: HardLimit; label: string }
  | { kind: 'phantom'; label: 'Phantom can clear' };

const ONLY_YOU_LABEL: Readonly<Partial<Record<HardLimit, string>>> = {
  secrets: 'Only you: secrets',
  money: 'Only you: money',
  'outside-send': 'Only you: outside send',
  'destroy-data': 'Only you: deletes data',
  authority: 'Only you: signing or grants',
};

const PHANTOM: HardLimitLabel = { kind: 'phantom', label: 'Phantom can clear' };

export function hardLimitLabel(text: string): HardLimitLabel {
  const { limit } = classifyNeedsItem(text);
  const label = limit ? ONLY_YOU_LABEL[limit] : undefined;
  return limit && label ? { kind: 'only-you', limit, label } : PHANTOM;
}

/** Splits items by their title's hard limit, keeping input order in each half. */
export function splitByHardLimit<Item extends { title: string }>(items: readonly Item[]): {
  onlyYou: Item[];
  phantom: Item[];
  counts: { onlyYou: number; phantom: number };
} {
  const onlyYou: Item[] = [], phantom: Item[] = [];
  for (const item of items) (hardLimitLabel(item.title).kind === 'only-you' ? onlyYou : phantom).push(item);
  return { onlyYou, phantom, counts: { onlyYou: onlyYou.length, phantom: phantom.length } };
}
