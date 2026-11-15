import { describe, expect, it } from 'vitest';
import { callNativeTool } from '../src/core/mcp-native.js';

describe('recovered needs resolution', () => {
  it('rejects malformed item IDs before attempting resolution', async () => {
    const result = await callNativeTool('phantom_fleet_needs_resolve', { itemId: '../invalid' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('invalid needs resolve arguments');
  });
});
