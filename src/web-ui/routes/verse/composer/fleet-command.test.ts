import { describe, expect, it } from 'vitest';
import { matchSlashCommands, parseFleetCommand } from './composer-text.js';

describe('fleet command', () => {
  it('accepts multiline payloads and trims whitespace', () => {
    expect(parseFleetCommand('/fleet  First line\nsecond line  ')).toEqual({ text: 'First line\nsecond line' });
  });
  it.each(['/fleetx hello', '/fleet', '/fleet   ', 'hello /fleet message'])('rejects %s', (draft) => {
    expect(parseFleetCommand(draft)).toBeNull();
  });
  it('caps the payload at 6000 characters', () => {
    expect(parseFleetCommand(`/fleet ${'x'.repeat(6001)}`)?.text).toHaveLength(6000);
  });
  it('offers fleet for fl', () => {
    expect(matchSlashCommands('fl').map(command => command.id)).toContain('fleet');
  });
});
