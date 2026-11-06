import { describe, expect, it } from 'vitest';
import { matchSlashCommands, parseReleaseCommand } from './composer-text.js';

describe('release command parsing', () => {
  it('accepts a lane and optional trimmed reason', () => {
    expect(parseReleaseCommand('/release codex-personal   mason order  ')).toEqual({ lane: 'codex-personal', reason: 'mason order' });
    expect(parseReleaseCommand('/release devin')).toEqual({ lane: 'devin', reason: '' });
  });
  it('bounds a long reason', () => {
    expect(parseReleaseCommand(`/release devin ${'x'.repeat(201)} `)).toEqual({ lane: 'devin', reason: 'x'.repeat(200) });
  });
  it.each(['/release', '/release Codex', '/release a'])('rejects %s', draft => {
    expect(parseReleaseCommand(draft)).toHaveProperty('error');
  });
  it('ignores unrelated text and offers the command', () => {
    expect(parseReleaseCommand('/releases devin')).toBeNull();
    expect(matchSlashCommands('rel').map(command => command.id)).toContain('release');
  });
});
