import { describe, expect, it } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety, registerNativeTools } from '../src/core/mcp-native.js';
import { registerFleetNativeTools } from '../src/core/mcp-native-fleet.js';

// RQ-PHX-REDTESTFIXN1S126 recut pin: #4860's mcp-native.ts predates master's
// registerNativeTools export (called by mcp-native-fleet.ts), so the merge
// candidate crashed `phm mcp list` and the compact-JSON inventory test. The
// tool must also stay ordered after phantom_fleet_needs_resolve so the
// inventory classification and snapshots hold.
describe('needs wait recut invariants', () => {
  it('keeps registerNativeTools exported for the fleet registrar', () => {
    expect(typeof registerNativeTools).toBe('function');
    expect(() => registerFleetNativeTools()).not.toThrow();
  });

  it('lists phantom_fleet_needs_wait between needs_resolve and orders', () => {
    const names = listNativeTools().map(tool => tool.name);
    const resolve = names.indexOf('phantom_fleet_needs_resolve');
    const wait = names.indexOf('phantom_fleet_needs_wait');
    const orders = names.indexOf('phantom_fleet_orders');
    expect(wait).toBeGreaterThan(resolve);
    expect(wait).toBeLessThan(orders);
    expect(nativeToolSafety('phantom_fleet_needs_wait')).toBe('read');
  });

  it('rejects malformed args with the needs wait validation message', async () => {
    for (const args of [
      {},
      { itemId: 'not-an-item', timeoutMs: 500 },
      { itemId: 'nm-0123456789ab' },
      { itemId: 'nm-0123456789ab', timeoutMs: 0 },
      { itemId: 'nm-0123456789ab', timeoutMs: 30001 },
      { itemId: 'nm-0123456789ab', timeoutMs: 500, pollMs: 50 },
      { itemId: 'nm-0123456789ab', timeoutMs: 500, extra: true },
    ]) {
      const result = await callNativeTool('phantom_fleet_needs_wait', args);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('invalid fleet needs wait arguments');
    }
  });
});
