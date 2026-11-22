import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const document = readFileSync(new URL('../docs/FLEET-MCP-TOOLS.md', import.meta.url), 'utf8');
type Tool = { name: string; description?: string };

function validateCatalog(doc: string, tools: Tool[]) {
  const rows = [...doc.matchAll(/^\| `([^`]+)` \| (.*) \|$/gm)].map((match) => ({
    name: match[1]!,
    description: JSON.parse(`"${match[2]!.replace(/\\\|/g, '|')}"`) as string,
  }));
  expect(tools.length).toBeGreaterThan(0);
  expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
  expect(rows.sort((a, b) => a.name.localeCompare(b.name)))
    .toEqual(tools.map(({ name, description }) => ({ name, description }))
      .sort((a, b) => a.name.localeCompare(b.name)));
}

it('matches the fleet tools/list contract and rejects catalog drift', async () => {
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}) });
  const client = new Client({ name: 'fleet-catalog-test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    validateCatalog(document, tools);
    const row = document.split('\n').find((line) => line.startsWith(`| \`${tools[0]!.name}\` |`));
    expect(row).toBeDefined();
    for (const replacement of [
      '', `${row}\n${row}`, `| \`${tools[0]!.name}\` | Incorrect description |`,
      `${row}\n| \`fleet_obsolete_fixture\` | Obsolete |`,
    ]) {
      expect(() => validateCatalog(document.replace(row!, replacement), tools)).toThrow();
    }
  } finally {
    await Promise.all([client.close(), server.close(), serverTransport.close(), clientTransport.close()]);
  }
});
