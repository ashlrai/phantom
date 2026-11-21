import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const doc = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
function validate(document: string, tools: { name: string; description?: string }[]) {
  const section = document.split('## `phantom-fleet`')[1]?.split('\n## ')[0] ?? '';
  const rows = [...section.matchAll(/^\| phantom-fleet \| `([^`]+)` \| (.*) \|$/gm)]
    .map(m => [m[1], m[2]!.replace(/\\\|/g, '|')]);
  expect(tools.length).toBeGreaterThan(0);
  expect(rows.sort()).toEqual(tools.map(t => [t.name, t.description]).sort());
}

it.each(['current', 'missing', 'duplicate', 'description', 'obsolete'])('fleet catalog: %s', async variant => {
  const server = createFleetServer({});
  const client = new Client({ name: 'fleet-catalog-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const { tools } = await client.listTools();
    const row = doc.split('\n').find(line => line.startsWith(`| phantom-fleet | \`${tools[0]!.name}\``))!;
    const replacement = { missing: '', duplicate: `${row}\n${row}`, description: row.replace(/(` \| ).* \|$/, '$1Wrong description |'), obsolete: `${row}\n| phantom-fleet | \`fleet_obsolete_fixture\` | Fake obsolete tool |` };
    if (variant === 'current') validate(doc, tools);
    else expect(() => validate(doc.replace(row, replacement[variant as keyof typeof replacement]), tools)).toThrow();
  } finally { await Promise.all([client.close(), server.close(), a.close(), b.close()]); }
});
