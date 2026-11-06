import { describe, expect, it } from 'vitest';
import { BUILTIN_ENGINE_REGISTRY, compileArgv, extractGrokStreamText } from '../src/core/run/engine-registry.js';
import { createEngineOutputNormaliser } from '../src/core/run/engines.js';

describe('Claude JSON adapter', () => {
  it('preserves DEL and zero-width space in the prompt passed to the JSON-mode CLI', () => {
    const goal = 'before\u007fbetween\u200bafter';
    const spec = BUILTIN_ENGINE_REGISTRY.claude!;
    expect(compileArgv(spec.argv!, { goal, cwd: '/fixture' })).toEqual([
      '-p', goal, '--output-format', 'json',
    ]);
  });

  it('decodes escaped DEL, zero-width space and JSON control characters in the native result', () => {
    const line = '{"type":"result","subtype":"success","is_error":false,' +
      '"result":"before\\u007fbetween\\u200bafter\\u000aend",' +
      '"usage":{"input_tokens":7,"output_tokens":3}}';
    const result = extractGrokStreamText(line);
    expect(result).toMatchObject({ text: 'before\u007fbetween\u200bafter\nend', error: null, tokensIn: 7, tokensOut: 3 });
    const normaliser = createEngineOutputNormaliser({ bin: 'claude', args: ['--output-format', 'json'] });
    expect(normaliser.line(line, 1)).toMatchObject([{ kind: 'usage', text: 'tokensIn=7 tokensOut=3' }]);
    expect(normaliser.terminalError()).toBeNull();
  });
});
