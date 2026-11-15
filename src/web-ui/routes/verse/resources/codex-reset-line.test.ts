import { describe, expect, it } from 'vitest';
import { codexFreeResetsLine, codexResetLine, type CodexResetRow } from './codex-reset-line.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const win = (resetsAt: string | null) => ({ id: 'weekly', label: 'weekly window', usedPercent: 40, limitReached: false, resetText: null, resetsAt, binding: true });
const row = (over: Partial<CodexResetRow> = {}): CodexResetRow => ({ engine: 'codex', windows: [], resetAt: null, ...over });

describe('codexResetLine', () => {
  it('is null without any reset field', () => {
    expect(codexResetLine(row({ windows: [win(null)] }), NOW)).toBeNull();
    expect(codexResetLine(row({ windows: [win('garbage')] }), NOW)).toBeNull();
  });
  it('says reset due once the instant has passed', () => {
    expect(codexResetLine(row({ windows: [win('2026-11-09T10:00:00Z')] }), NOW)).toMatch(/^Reset due \(was .+\) · waiting for a fresh reading$/);
  });
  it('formats date and relative time for a future reset', () => {
    const line = codexResetLine(row({ windows: [win('2026-11-12T15:30:00Z')] }), NOW);
    expect(line).toMatch(/^Resets .+ \(in 3d 3h\)$/);
  });
  it('falls back to the seat reset and stays null off Codex', () => {
    expect(codexResetLine(row({ resetAt: '2026-11-09T12:45:00Z' }), NOW)).toMatch(/\(in 45m\)$/);
    expect(codexResetLine(row({ engine: 'claude', resetAt: '2026-11-09T12:45:00Z' }), NOW)).toBeNull();
  });
});

describe('codexFreeResetsLine', () => {
  it('is null when no count is carried or it is not a whole number', () => {
    expect(codexFreeResetsLine(row())).toBeNull();
    expect(codexFreeResetsLine(row({ freeResetsAvailable: null }))).toBeNull();
    expect(codexFreeResetsLine(row({ freeResetsAvailable: 1.5 }))).toBeNull();
    expect(codexFreeResetsLine(row({ freeResetsAvailable: -1 }))).toBeNull();
  });
  it('states a confirmed count', () => {
    expect(codexFreeResetsLine(row({ freeResetsAvailable: 2 }))).toBe('Free resets: 2 available');
    expect(codexFreeResetsLine(row({ freeResetsAvailable: 0 }))).toBe('Free resets: 0 available');
  });
});
