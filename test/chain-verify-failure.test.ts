import { expect, it, vi } from 'vitest';

vi.mock('../src/core/fabric/resource-view.js', () => ({
  buildResourceView: () => { throw new Error('sensitive synthetic exception'); },
}));

it('fails closed, blocks dependent links, and withholds exception text', async () => {
  const { verifyChain } = await import('../src/core/chain-verify.js');
  const report = await verifyChain();
  expect(report.status).toBe('fail');
  expect(report.links[0]).toMatchObject({ status: 'fail' });
  expect(report.links.slice(1).every(link => link.status === 'blocked' && link.latencyMs === null)).toBe(true);
  expect(JSON.stringify(report)).not.toContain('sensitive synthetic exception');
});
