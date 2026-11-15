import { expect, it, vi } from 'vitest';
import { callNativeTool } from '../src/core/mcp-native.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));

it('serves a filtered fleet catalog through the native entry point and bounds its input', async () => {
  const result = await callNativeTool('phantom_fleet_verbs', { grep: ' NEEDS ' });
  expect(result.isError).toBeUndefined();
  const catalog = JSON.parse(result.content[0].text);
  expect(catalog.schema).toBe('fleet.verbs.v1');
  expect(catalog.verbs.map((entry: { verb: string }) => entry.verb)).toContain('needs');
  expect((await callNativeTool('phantom_fleet_verbs', { grep: 'x'.repeat(65) })).isError).toBe(true);
});
