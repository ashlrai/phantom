import { describe, expect, it } from 'vitest';
import { parseReleaseCommand, renderReleaseReply } from './telegram-release-command.js';

describe('Telegram release command', () => {
  it('accepts only known, well-formed lanes', () => {
    expect(parseReleaseCommand('/release codex-personal')).toEqual({ lane: 'codex-personal' });
    expect(parseReleaseCommand('/release@phantombot devin')).toEqual({ lane: 'devin' });
    for (const lane of ['claude', 'codex-local', 'codex-cmp', 'claude-api']) expect(parseReleaseCommand(`/release ${lane}`)).toEqual({ lane });
    for (const text of ['/release', '/release ../x', '/release unknown-lane', '/release Devin', '/release devin extra', '/release devin\nextra']) expect(parseReleaseCommand(text)).toBeNull();
  });

  it('renders short, safe acknowledgements', () => {
    expect(renderReleaseReply({ status: 'released', lane: 'codex-personal', target: 24 })).toBe('codex-personal released. Target 24.');
    expect(renderReleaseReply({ status: 'released', lane: 'codex-personal' })).toBe('codex-personal released.');
    expect(renderReleaseReply({ status: 'not-held', lane: 'codex-personal' })).toBe('codex-personal is not held.');
    expect(renderReleaseReply({ status: 'failed', reason: 'manual-hold' })).toBe('Release failed: lane was held manually.');
    expect(renderReleaseReply({ status: 'failed', reason: 'unavailable' })).toBe('Release failed: lane holds unavailable.');
  });
});
