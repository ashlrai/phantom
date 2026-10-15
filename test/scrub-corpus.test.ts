/**
 * Detection and false-alarm corpus for scrubSecrets, written by a separate agent that did not read the scrubber
 * (test/fixtures/scrub). True positives must stay redacted and idempotent; ordinary prose, credential variable
 * names, code references, public digests and placeholders must pass through unchanged.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../src/core/util/scrub.js';

interface Positive { id: string; family: string; parts: string[]; secretParts: number[] }
interface Negative { id: string; family: string; text: string }
const load = <T>(name: string): T[] => (JSON.parse(readFileSync(new URL(`./fixtures/scrub/${name}`, import.meta.url), 'utf8')) as { cases: T[] }).cases;
const positives = load<Positive>('true-positives.json').filter(entry => entry.family !== 'home-path'); // home paths: scrubPrivateText, not scrubSecrets
const negatives = load<Negative>('false-positives.json');
// Written after these fixes were frozen and never tuned on: it measures how well detection generalizes.
const heldOut = load<Positive>('held-out-positives.json');

// Known false alarms, kept visible so a later fix can remove them. Never add to this list; every credential must be caught.
const KNOWN_FALSE_ALARMS = new Set(['fp-prose-token-003', 'fp-code-reference-011', 'fp-code-reference-025', 'fp-config-without-values-004',
  'fp-config-without-values-010', 'fp-config-without-values-027']);

// Held-out credentials the scrubber still misses (147/183 caught). Only remove ids from this list; a fix that tunes on
// this batch must be validated on a fresh one.
const KNOWN_HELD_OUT_MISSES = ['go-short-assign-004', 'go-short-assign-009', 'go-short-assign-017', 'go-short-assign-020', 'misc-001',
  'misc-006', 'misc-007', 'misc-009', 'misc-021', 'misc-024', 'misc-049', 'misc-052', 'misc-056', 'misc-058', 'name-suffix-003',
  'name-suffix-010', 'name-suffix-013', 'name-suffix-016', 'name-suffix-017', 'name-suffix-020', 'name-suffix-022',
  'prose-disclosure-001', 'prose-disclosure-005', 'prose-disclosure-006', 'prose-disclosure-007', 'prose-disclosure-008',
  'prose-disclosure-009', 'prose-disclosure-010', 'prose-disclosure-012', 'prose-disclosure-013', 'prose-disclosure-014',
  'prose-disclosure-017', 'prose-disclosure-018', 'prose-disclosure-020', 'prose-disclosure-021', 'prose-disclosure-023'];

describe('scrubSecrets corpus', () => {
  it('redacts every credential, idempotently', () => {
    expect(positives.length).toBeGreaterThan(180);
    for (const entry of positives) {
      const text = entry.parts.join(''); const once = scrubSecrets(text);
      const leaked = entry.secretParts.some(index => once.includes(entry.parts[index]!));
      expect(leaked, entry.id).toBe(false);
      expect(scrubSecrets(once), entry.id).toBe(once);
    }
  });
  it('redacts held-out credentials except the known misses, idempotently', () => {
    expect(heldOut.length).toBeGreaterThan(180);
    const missed = heldOut.filter(entry => {
      const text = entry.parts.join(''); const once = scrubSecrets(text);
      expect(scrubSecrets(once), entry.id).toBe(once);
      return entry.secretParts.some(index => once.includes(entry.parts[index]!));
    }).map(entry => entry.id).sort();
    expect(missed).toEqual(KNOWN_HELD_OUT_MISSES);
  });
  it('leaves prose, credential variable names, code references, public digests and placeholders unchanged', () => {
    expect(negatives.length).toBeGreaterThan(120);
    const flagged = negatives.filter(entry => scrubSecrets(entry.text) !== entry.text).map(entry => entry.id).sort();
    expect(flagged).toEqual([...KNOWN_FALSE_ALARMS].sort());
  });
});
