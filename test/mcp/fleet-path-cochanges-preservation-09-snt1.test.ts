import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createFleetServer } from '../../src/mcp/fleet-server.js';

describe('cochanges preservation on the current fleet server', () => {
  it('lists and dispatches cochanges alongside job patch and current, rejecting invalid calls before reading', async () => {
    const pathCochanges = vi.fn(async () => ({ notice: 'evidence only' }));
    const jobPatch = vi.fn(async () => ({ kind: 'patch' }));
    const jobCurrent = vi.fn(async () => ({ kind: 'current' }));
    const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), pathCochanges, jobPatch, jobCurrent });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'preservation-test', version: '1' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['fleet_path_cochanges', 'fleet_job_patch', 'fleet_job_current']));
      for (const args of [{ path: '../unsafe' }, { path: 'a', ref: 'HEAD' }, { path: 'a', limit: 1.5 }]) {
        await expect(client.callTool({ name: 'fleet_path_cochanges', arguments: args })).rejects.toMatchObject({ code: -32602 });
      }
      expect(pathCochanges).not.toHaveBeenCalled();
      await client.callTool({ name: 'fleet_path_cochanges', arguments: { path: 'src/a.ts' } });
      await client.callTool({ name: 'fleet_job_patch', arguments: { jobId: 'RQ-EXAMPLE-1' } });
      await client.callTool({ name: 'fleet_job_current', arguments: { jobId: 'RQ-EXAMPLE-1' } });
      expect(pathCochanges).toHaveBeenCalledExactlyOnceWith({ path: 'src/a.ts', limit: 20 });
      expect(jobPatch).toHaveBeenCalledOnce();
      expect(jobCurrent).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
