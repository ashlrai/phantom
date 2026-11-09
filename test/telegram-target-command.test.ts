import { describe, expect, it } from 'vitest';
import { parseTargetCommand, renderTargetReply } from '../src/core/comms/telegram-target-command.js';
import { telegramHtmlToPlain } from '../src/core/integrations/telegram-format.js';

describe('Telegram lane target commands', () => {
  it('accepts a bot suffix, whitespace, zero and safe integer targets', () => {
    expect(parseTargetCommand('  /TARGET@FleetBot lane-1 0\n')).toEqual({ lane: 'lane-1', target: 0 });
    expect(parseTargetCommand('/target ab 9007199254740991')).toEqual({ lane: 'ab', target: Number.MAX_SAFE_INTEGER });
  });

  it('rejects malformed commands, invalid lane IDs and non-integer or unsafe targets', () => {
    for (const text of [
      '/target a 1', '/target Lane 1', '/target -lane 1', `/target ${'a'.repeat(32)} 1`,
      '/target lane -1', '/target lane +1', '/target lane 1.0', '/target lane 1e2',
      '/target lane 9007199254740992', '/target lane 1 extra', '/target lane', '/targets lane 1',
    ]) expect(parseTargetCommand(text), text).toBeNull();
  });

  it('renders held and unheld results and fixed failure reasons', () => {
    expect(renderTargetReply({ status: 'set', lane: 'lane-1', target: 2, held: false })).toBe('lane-1 target set to 2.');
    expect(renderTargetReply({ status: 'set', lane: 'lane-1', target: 0, held: true })).toBe('lane-1 target set to 0. Its hold remains active — the target applies when it lifts.');
    expect(renderTargetReply({ status: 'failed', reason: 'unknown-lane' })).toBe('Target not set: lane is unavailable.');
    expect(renderTargetReply({ status: 'failed', reason: 'out-of-range' })).toBe('Target not set: target is outside the lane bounds.');
    expect(renderTargetReply({ status: 'failed', reason: 'unavailable' })).toBe('Target not set: lane targets unavailable.');
  });
});

describe('Telegram HTML plain fallback', () => {
  it('strips markup and decodes supported entities exactly once', () => {
    expect(telegramHtmlToPlain('<b>A &amp; B</b> &lt;tag&gt; &quot;x&quot; &amp;lt;')).toBe('A & B <tag> "x" &lt;');
    expect(telegramHtmlToPlain('plain &unknown;')).toBe('plain &unknown;');
  });
});
