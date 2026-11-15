import { describe, expect, it, vi } from 'vitest';
import { verifyChain } from '../src/core/chain-verify.js';
import { cmdChain } from '../src/cli/chain.js';

describe('synthetic chain verification', () => {
  it('exercises all links and reports measured latency without host state', async () => {
    const result = await verifyChain();
    expect(result.status).toBe('pass');
    expect(result.scope).toBe('synthetic');
    expect(result.links.map(row => row.link)).toEqual(['resource-bars', 'model-router', 'load-balancer', 'agent-messaging', 'parallel-orchestration', 'leader-human-comms']);
    expect(result.links.every(row => row.status === 'pass' && row.latencyMs !== null && row.latencyMs >= 0)).toBe(true);
  });
  it('provides JSON and rejects unexpected arguments', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdChain(['verify', '--json'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]![0])).scope).toBe('synthetic');
      expect(await cmdChain(['verify', '--apply'])).toBe(2);
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});
