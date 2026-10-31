import { describe, expect, it } from 'vitest';
import { matchSlashCommands, parseLaneCommand } from './composer-text.js';

describe('lane command parsing', () => {
  it('accepts a valid lane and target', () => {
    expect(parseLaneCommand('/lane codex-personal 20')).toEqual({ lane: 'codex-personal', target: 20 });
    expect(parseLaneCommand('/lane devin 0')).toEqual({ lane: 'devin', target: 0 });
    expect(parseLaneCommand('/lane devin 999')).toEqual({ lane: 'devin', target: 999 });
  });
  it.each(['/lane Codex 2', '/lane devin 1000', '/lane devin x', '/lane', '/lane devin -1', '/lane devin 1.5', '/lane devin 2 extra', '/lane a 1'])('rejects %s', draft => {
    expect(parseLaneCommand(draft)).toHaveProperty('error');
  });
  it.each(['/fleet hi', 'plain text', '/lanes devin 2'])('ignores %s', draft => {
    expect(parseLaneCommand(draft)).toBeNull();
  });
  it('offers lane in autocomplete', () => {
    expect(matchSlashCommands('la').map(command => command.id)).toContain('lane');
  });
});
