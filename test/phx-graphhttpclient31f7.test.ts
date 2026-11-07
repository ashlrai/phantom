import { request } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { startGraphServer } from '../src/api/graph-http.js';
import type { KnowledgeGraph } from '../src/core/types.js';

// A client needs only the listener URL and the process-local read capability.
function getJson(url: string, token: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET', agent: false, headers: { 'X-Ashlr-Token': token },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(2_000, () => req.destroy(new Error('Graph request timed out')));
    req.on('error', reject);
    req.end();
  });
}

describe('standalone graph HTTP consumer', () => {
  it('authenticates, reads opaque nodes and fresh snapshots, then closes the listener', async () => {
    const nodeId = 'module:fake-repo/東京/%2F?# λ.ts';
    const node = { id: nodeId, kind: 'module', label: 'Fake initial module' };
    let snapshot: KnowledgeGraph = {
      nodes: [
        { id: 'repo:fake-repo', kind: 'repo', label: 'Fake repo' },
        node,
        { id: 'dep:@fake/package', kind: 'dep', label: '@fake/package' },
      ],
      edges: [
        { from: 'repo:fake-repo', to: nodeId, kind: 'contains' },
        { from: nodeId, to: 'dep:@fake/package', kind: 'imports' },
      ],
      crossRepo: [{ kind: 'shared-dep', detail: '@fake/package', repos: ['fake-repo', 'fake-other'] }],
    };
    const readGraph = vi.fn(() => snapshot);
    const handle = await startGraphServer({ host: '127.0.0.1', port: 0 }, { readGraph });
    const nodeUrl = `${handle.url}/graph/nodes/${encodeURIComponent(nodeId)}`;

    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);
      expect((await getJson(`${handle.url}/graph`, 'plainly-fake-wrong-token')).status).toBe(401);
      expect(readGraph).not.toHaveBeenCalled();

      expect(await getJson(`${handle.url}/graph`, handle.readToken)).toEqual({ status: 200, body: snapshot });
      expect(await getJson(nodeUrl, handle.readToken)).toEqual({ status: 200, body: node });

      const updatedNode = { ...node, label: 'Fake updated module' };
      snapshot = { ...snapshot, nodes: [snapshot.nodes[0]!, updatedNode], edges: [], crossRepo: [] };
      expect(await getJson(nodeUrl, handle.readToken)).toEqual({ status: 200, body: updatedNode });
      expect(await getJson(`${handle.url}/graph`, handle.readToken)).toEqual({ status: 200, body: snapshot });
      expect(readGraph).toHaveBeenCalledTimes(4);

      await handle.close();
      await expect(getJson(`${handle.url}/graph`, handle.readToken)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(readGraph).toHaveBeenCalledTimes(4);
    } finally {
      await handle.close();
    }
  });
});
