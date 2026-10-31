import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => readFileSync(new URL(`../leader/${file}`, import.meta.url), 'utf8');
const sections = (text: string, kind: string): string[] =>
  text.split(new RegExp(`^## ${kind}\\d+ — `, 'm')).slice(1);
const fields = ['Evidence', 'Implementation', 'NEW tests', 'Change', 'Acceptance',
  'Dependencies', 'Size', 'Benefit', 'Verification'];

function completeBet(section: string): boolean {
  return /^READY: .+/m.test(section)
    && fields.every(field => new RegExp(`^- ${field}: \\S.+$`, 'm').test(section))
    && /Implementation: `src\/[^`]+\.ts`/.test(section)
    && /NEW tests: `test\/[^`]+\.test\.ts`/.test(section);
}

function datedSource(section: string): boolean {
  const date = section.match(/^- Checked: (\d{4}-\d{2}-\d{2})\./m)?.[1];
  return date !== undefined
    && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date
    && /^- Source: .*\[[^\]]+\]\(https:\/\/[^\s)]+\)/m.test(section);
}

describe('harness inspiration handoff structure 31k', () => {
  it('keeps each digest source dated and linked offline', () => {
    const entries = sections(read('INSPIRATION.md'), 'S');
    expect(entries.length).toBeGreaterThanOrEqual(7);
    for (const entry of entries) expect(datedSource(entry)).toBe(true);
  });

  it('keeps four to six READY contracts complete with exact paths', () => {
    const bets = sections(read('READY-HARNESS-BETS.md'), 'B');
    expect(bets.length).toBeGreaterThanOrEqual(4);
    expect(bets.length).toBeLessThanOrEqual(6);
    for (const bet of bets) expect(completeBet(bet)).toBe(true);
    const tests = bets.map(bet => bet.match(/NEW tests: `([^`]+)`/)?.[1]);
    expect(new Set(tests).size).toBe(bets.length);
  });

  it('rejects missing structural fields without constraining prose', () => {
    const bet = sections(read('READY-HARNESS-BETS.md'), 'B')[0]!;
    for (const field of fields) {
      expect(completeBet(bet.replace(new RegExp(`^- ${field}: .+$`, 'm'), ''))).toBe(false);
    }
    expect(datedSource('- Checked: 2026-02-30.\n- Source: [x](https://example.com)')).toBe(false);
    expect(datedSource('- Checked: 2026-10-31.\n- Source: unlinked')).toBe(false);
  });
});
