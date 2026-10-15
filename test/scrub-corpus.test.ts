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

// Gaps that exist on master before this change, kept visible so a later fix can remove them. Never add to these lists.
const KNOWN_LEAKS = new Set(['aws-access-key-id-006', 'basic-auth-001', 'basic-auth-002', 'basic-auth-004', 'basic-auth-005', 'basic-auth-006',
  'pem-004', 'base64-blob-001', 'base64-blob-004', 'base64-blob-005', 'base64-blob-006', 'generic-assignment-018',
  'suffix-names-004', 'suffix-names-007', 'suffix-names-010']);
const KNOWN_NOT_IDEMPOTENT = new Set(['openai-003', 'slack-token-002', 'aws-secret-key-002', 'google-api-key-005', 'huggingface-003', 'xai-003']);
const KNOWN_FALSE_ALARMS = new Set(['fp-prose-token-003', 'fp-code-reference-011', 'fp-code-reference-025', 'fp-config-without-values-004',
  'fp-config-without-values-010', 'fp-config-without-values-026', 'fp-config-without-values-027']);

describe('scrubSecrets corpus', () => {
  it('redacts every credential it detected before, idempotently', () => {
    expect(positives.length).toBeGreaterThan(180);
    for (const entry of positives) {
      const text = entry.parts.join(''); const once = scrubSecrets(text);
      const leaked = entry.secretParts.some(index => once.includes(entry.parts[index]!));
      expect(leaked, entry.id).toBe(KNOWN_LEAKS.has(entry.id));
      expect(scrubSecrets(once) !== once, entry.id).toBe(KNOWN_NOT_IDEMPOTENT.has(entry.id));
    }
  });
  it('leaves prose, credential variable names, code references, public digests and placeholders unchanged', () => {
    expect(negatives.length).toBeGreaterThan(120);
    const flagged = negatives.filter(entry => scrubSecrets(entry.text) !== entry.text).map(entry => entry.id).sort();
    expect(flagged).toEqual([...KNOWN_FALSE_ALARMS].sort());
  });
});
