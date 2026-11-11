import { expect, it } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

it('exposes intent evidence tools and rejects invalid evidence', async () => {
  for (const name of ['intent_link', 'intent_ship']) {
    expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toMatchObject({ additionalProperties: false });
    expect(nativeToolSafety(name)).toBe('append');
    expect((await callNativeTool(name, { extra: true })).isError).toBe(true);
  }
});
