import { expect, it } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

it('exposes intent evidence tools and rejects malformed evidence at the native entry point', async () => {
  for (const name of ['intent_link', 'intent_ship']) {
    expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toMatchObject({ additionalProperties: false });
    expect(nativeToolSafety(name)).toBe('append');
    const result = await callNativeTool(name, { unexpected: true });
    expect(result.isError).toBe(true);
  }
});
