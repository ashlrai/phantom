import { describe, expect, it } from 'vitest';

import { redactKnownValues } from '../src/core/util/scrub.js';

const KEY = '9f8e7d6c5b4a39281706f5e4d3c2b1a0';

describe('redactKnownValues', () => {
  it('replaces a whole echoed key with one marker', () => {
    expect(redactKnownValues(`bad key: ${KEY}.`, [KEY])).toBe('bad key: [REDACTED].');
  });

  it('replaces any run of 8 or more characters of the key', () => {
    expect(redactKnownValues(`key ****${KEY.slice(10, 19)}****`, [KEY])).toBe('key ****[REDACTED]****');
  });

  it('leaves runs shorter than 8 characters and unrelated text alone', () => {
    const text = `last four ${KEY.slice(-4)}, prefix ${KEY.slice(0, 7)}, status 401`;
    expect(redactKnownValues(text, [KEY])).toBe(text);
  });

  it('ignores missing and short secrets', () => {
    expect(redactKnownValues('Bearer abc and nothing else', [undefined, null, '', 'abc'])).toBe('Bearer abc and nothing else');
  });

  it('covers several secrets and repeated echoes', () => {
    const other = 'local-gateway-key-FAKE-2026';
    expect(redactKnownValues(`${KEY} / ${other} / ${KEY}`, [KEY, other])).toBe('[REDACTED] / [REDACTED] / [REDACTED]');
  });
});
