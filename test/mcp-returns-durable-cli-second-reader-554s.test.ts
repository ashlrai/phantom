import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReturnsCheck } from '../src/cli/fleet-returns-check.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('durable return across independent MCP lifetimes and CLI (554s)', () => {
  it('retains the named producer receipt while only the independent check establishes a merge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'returns-second-reader-554s-'));
    try {
      for (const key of ['HOME', 'USERPROFILE', 'ASHLR_HOME', 'ASHLR_RUNS_ROOT']) vi.stubEnv(key, root);
      const path = join(root, 'coordination.jsonl');
      vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
      const repo = 'synthetic/second-reader', agent = 'synthetic-offhost-554s';
      const head = 'abcdef1234567890abcdef1234567890abcdef12', pr = 554;
      // Real clock and ample TTL: MCP's own timeout machinery remains untouched.
      const claim = claimFleetWork({ repo, agent, task: 'Synthetic off-host return', ttlMs: 3_600_000 });
      if (!claim.ok) throw new Error(`fixture claim failed: ${claim.error}`);
      const { claim: owned, lease } = claim.value;
      const returned = returnFleetClaim({ id: owned.id, agent, lease, pr, head, ttlMs: 3_600_000 });
      expect(returned).toMatchObject({ ok: true, outcome: 'returned', claimId: owned.id });
      if (!returned.message) throw new Error('fixture return lacks receipt');
      const expected = {
        claimId: owned.id, repo, from: agent, result: 'VERIFIED', evidenceKind: 'pr', pr, head,
        evidence: `pr #${pr} head ${head}`, temporal: 'current',
        at: new Date(returned.message.at).toISOString(),
        expiresAt: new Date(returned.message.expiresAt).toISOString(),
      };
      expect(returned.message.id).toBe(`return-${owned.id}`);
      const bytes = readFileSync(path);
      const entries = readdirSync(root, { recursive: true }).sort();
      const unchanged = () => {
        expect(readFileSync(path)).toEqual(bytes); // Includes row count, content and original timing.
        expect(readdirSync(root, { recursive: true }).sort()).toEqual(entries);
      };
      const privateValues = [lease, createHash('sha256').update(lease).digest('hex'), path];
      const noPrivateMaterial = (text: string) => {
        for (const value of privateValues) expect(text).not.toContain(value);
        expect(text).not.toMatch(/"lease(?:Hash)?"/i);
      };
      let firstReceipt: unknown;
      for (let lifetime = 0; lifetime < 2; lifetime++) {
        const client = new Client({ name: `synthetic-reader-${lifetime}`, version: '1.0.0' });
        const server = createFleetServer();
        const [ct, st] = InMemoryTransport.createLinkedPair();
        try {
          await server.connect(st);
          await client.connect(ct);
          const { tools } = await client.listTools();
          const tool = tools.find(row => row.name === 'fleet_coordination_returns');
          expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
          expect(Object.keys((tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort())
            .toEqual(['before', 'claim', 'contains', 'from', 'repo', 'result', 'since']);
          expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false,
            idempotentHint: true, openWorldHint: false });
          const read = async () => {
            const result = await client.callTool({ name: 'fleet_coordination_returns', arguments: {} });
            expect(result.isError).not.toBe(true);
            const content = result.content as Array<{ type: string; text: string }>;
            expect(content[0]?.type).toBe('text');
            const text = content[0]!.text;
            noPrivateMaterial(text);
            const view = JSON.parse(text);
            expect(view).toMatchObject({ state: 'known', source: 'coordination-ledger', unparsed: 0,
              coverage: { parsedTotal: 1, omitted: 0, unparsed: 0 } });
            expect(view.returns).toEqual([expected]);
            expect(Date.parse(view.asOf)).toBeGreaterThanOrEqual(returned.message!.at);
            unchanged();
            return view.returns[0];
          };
          const receipt = await read();
          if (lifetime === 0) { firstReceipt = receipt; continue; }
          expect(receipt).toEqual(firstReceipt);
          const log = vi.spyOn(console, 'log').mockImplementation(() => {});
          for (const merged of [false, true]) {
            const mergedAt = merged ? new Date().toISOString() : null;
            const gh = vi.fn(async (args: string[]) => {
              expect(args).toEqual(['api', '-H', 'Accept: application/vnd.github+json',
                `repos/${repo}/pulls/${pr}`]);
              return JSON.stringify({ number: pr, base: { repo: { full_name: repo } },
                state: merged ? 'closed' : 'open', merged, merged_at: mergedAt, head: { sha: head } });
            });
            log.mockClear();
            expect(await cmdFleetReturnsCheck(['--json'], { gh })).toBe(merged ? 0 : 1);
            expect(gh).toHaveBeenCalledTimes(1);
            expect(log).toHaveBeenCalledTimes(1);
            const output = String(log.mock.calls[0]![0]);
            noPrivateMaterial(output);
            expect(JSON.parse(output)).toMatchObject({ authority: 'none', returnsState: 'known',
              skipped: 0, truncated: false, receipts: [expected], checked: [{ claimId: owned.id,
                repo, pr, head, observedHead: head, mergedAt, verdict: merged ? 'merged-at-head' : 'open' }] });
            unchanged();
            // A merge verdict never rewrites the producer's VERIFIED receipt.
            expect(await read()).toEqual(firstReceipt);
          }
        } finally {
          try { await client.close(); } finally {
            try { await server.close(); } finally { await ct.close(); await st.close(); }
          }
        }
        unchanged();
      }
      unchanged();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
