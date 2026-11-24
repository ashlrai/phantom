import { describe, expect, it } from 'vitest';
import { conversationalPrompt, extractMessageRefs, referencedRecords, sanitizeOutbound, signedReply, templateReply } from '../src/core/comms/imessage-teammate-composer.js';

const MESSAGE = 'Handoff: RQ-DOCS-7 is published as PR #6123 at commit 3f9c2ab1, FIXUP-CI-9 still open.';
const files: Record<string, string> = {
  'metrics/jobs.jsonl': [
    '{"id":"RQ-DOCS-70","status":"failed"}',
    '{"id":"RQ-DOCS-7","status":"running"}',
    '{"id":"RQ-DOCS-7","status":"published","owner":"agent@example.test"}',
  ].join('\n'),
  'queue/ready.tsv': 'RQ-OTHER-1\tphantom\tclaude\twork\tprompt.md',
};
const tail = (relative: string): string | null => files[relative] ?? null;

describe('teammate reply composer', () => {
  it('extracts job ids, PR numbers and commit SHAs, and nothing from plain words or numbers', () => {
    expect(extractMessageRefs(MESSAGE)).toEqual({ jobs: ['RQ-DOCS-7', 'FIXUP-CI-9'], prs: ['6123'], shas: ['3f9c2ab1'] });
    expect(extractMessageRefs('All 1234567 rows are defaced, nothing else.')).toEqual({ jobs: [], prs: [], shas: [] });
  });
  it('returns the newest matching line per source, scrubbed, and never a longer job id', () => {
    const records = referencedRecords(extractMessageRefs('Is RQ-DOCS-7 done?'), tail, 1);
    expect(records).toMatch(/^metrics\/jobs\.jsonl: /);
    expect(records).toContain('"status":"published"');
    expect(records).not.toMatch(/example\.test|running|RQ-DOCS-70|RQ-OTHER/);
  });
  it('reads no file when the message names nothing and is empty when nothing matches', () => {
    expect(referencedRecords(extractMessageRefs('How are things?'), () => { throw new Error('unread'); })).toBe('');
    expect(referencedRecords(extractMessageRefs('Is RQ-MISSING-1 done?'), tail)).toBe('');
  });
  it('marks the template fallback and shows unknown as unknown', () => {
    const refs = extractMessageRefs(MESSAGE);
    expect(templateReply(refs, '')).toMatch(/^Automatic template reply/);
    expect(templateReply(refs, '')).toContain('about RQ-DOCS-7, FIXUP-CI-9, #6123, 3f9c2ab was received');
    expect(templateReply(refs, '')).toContain('status is unknown');
    expect(templateReply(refs, 'a: old\nb: new')).toContain('Newest matching record: b: new');
  });
  it('orders the prompt as message, records, message again, instruction', () => {
    const prompt = conversationalPrompt('MSG', 'REC');
    const order = [prompt.indexOf('MSG'), prompt.indexOf('REC'), prompt.lastIndexOf('MSG'), prompt.indexOf('Answer what this message says')];
    expect(order[0]).toBeGreaterThan(-1);
    expect(order).toEqual([...new Set(order)].sort((a, b) => a - b));
  });
});

describe('teammate outbound gate', () => {
  // This file carries no secret-shaped fixture, so the refusal is proven with a stubbed detector.
  const detectSecrets = (text: string): string => text.replace('FLAGGED', '[REDACTED]');
  it('refuses secret-shaped text and text with nothing left to send', () => {
    expect(sanitizeOutbound('The value is FLAGGED here.', { detectSecrets })).toBeNull();
    expect(signedReply('The value is FLAGGED here.', 7, { detectSecrets })).toBeNull();
    expect(sanitizeOutbound('The value is fine here.', { detectSecrets })).toBe('The value is fine here.');
    expect(sanitizeOutbound(' \u0000 ')).toBeNull();
    expect(sanitizeOutbound('<think>only reasoning, never closed')).toBeNull();
  });
  it('redacts emails, phone numbers and home paths but keeps job ids and dates', () => {
    const out = sanitizeOutbound('Ask agent@example.test or +15555550100 about /srv/agents/dot/notes.md for RQ-DOCS-7 on 2026-11-16 12:30.', { homes: ['/srv/agents/dot'] });
    expect(out).toBe('Ask [REDACTED] or [REDACTED] about ~/notes.md for RQ-DOCS-7 on 2026-11-16 12:30.');
  });
  it('strips think blocks and control characters', () => {
    expect(sanitizeOutbound('<think>plan</think>Queue is\u0007 empty.\u200b\n\n Next check soon.')).toBe('Queue is empty.\nNext check soon.');
  });
  it('cuts at a sentence boundary and keeps the signed message under 600 characters', () => {
    const signed = signedReply(Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' '), 4242);
    expect(signed?.length).toBeLessThan(600);
    expect(signed).toMatch(/is here\.\n— Phantom · ref \[4242\]$/);
    expect(sanitizeOutbound('word '.repeat(200), { maxChars: 50 })).toMatch(/^(?:word ?){5,9}…$/);
  });
});
