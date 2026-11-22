import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const doc = readFileSync(new URL('../docs/FLEET-MCP-TOOLS.md', import.meta.url), 'utf8');
function validate(document: string, tools: { name: string; description?: string }[]) {
  const rows = [...document.matchAll(/^\| `([^`]+)` \| (.*) \|$/gm)]
    .map(m => [m[1], m[2]!.replace(/\\\|/g, '|').replace(/<br>/g, '\n')]);
  expect(tools.length).toBeGreaterThan(0);
  expect(rows.sort()).toEqual(tools.map(t => [t.name, t.description]).sort());
}

it('matches fleet registrations and rejects catalog drift', async () => {
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}) });
  const client = new Client({ name: 'fleet-catalog-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const { tools } = await client.listTools();
    validate(doc, tools);
    const row = doc.split('\n').find(line => line.startsWith(`| \`${tools[0]!.name}\` |`))!;
    expect(row).toBeTruthy();
    for (const replacement of ['', `${row}\n${row}`, row.replace(/(` \| ).* \|$/, '$1Wrong description |'),
      `${row}\n| \`fleet_obsolete_fixture\` | Fake obsolete tool |`]) {
      expect(() => validate(doc.replace(row, replacement), tools)).toThrow();
    }
  } finally {
    await Promise.all([client.close(), server.close(), a.close(), b.close()]);
  }
});
