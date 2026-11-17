import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { listNativeTools } from '../src/core/mcp-native.js';
import { registerFleetNativeTools } from '../src/core/mcp-native-fleet.js';
import { createDocsServer } from '../src/mcp/docs-server.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

// docs/MCP-TOOLS.md must list every tool the three servers really register,
// once each, with the source description and the argument names.

interface Tool { name: string; description?: string; inputSchema: object }
interface Row { description: string; inputs: string }

const doc = readFileSync(join(process.cwd(), 'docs/MCP-TOOLS.md'), 'utf8');

/** Argument names, `?` after optional ones; matches the doc's Inputs column. */
function inputsOf(schema: object): string {
  const s = schema as { properties?: Record<string, unknown>; required?: string[] };
  const names = Object.keys(s.properties ?? {});
  const required = new Set(s.required ?? []);
  return names.length ? names.map(n => `\`${n}${required.has(n) ? '' : '?'}\``).join(', ') : 'none';
}

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Split a table row on unescaped pipes. */
function cells(line: string): string[] {
  return line.slice(1, -1).split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
}

/** Rows of one section, keyed by tool name; duplicates are reported by the caller. */
function section(heading: string): { rows: Map<string, Row>; names: string[] } {
  const body = doc.split(heading)[1]?.split(/\n## /)[0] ?? '';
  const rows = new Map<string, Row>();
  const names: string[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('|')) continue;
    const c = cells(line);
    const at = c.findIndex(cell => /^`[^`]+`$/.test(cell));
    if (at < 0) continue;
    const name = c[at]!.slice(1, -1);
    names.push(name);
    rows.set(name, { description: c[at + 1] ?? '', inputs: c[at + 2] ?? '' });
  }
  return { rows, names };
}

async function listOverMcp(server: { connect(t: unknown): Promise<void> }): Promise<Tool[]> {
  const client = new Client({ name: 'docs-mcp-tools-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

registerFleetNativeTools();

const gatewayHeadings = ['## `phantom_`', '## `phm_`', '## `ashlr_`', '## `desktop_`', '## `world_`', '## `intent_`'];

describe('docs/MCP-TOOLS.md matches the registered MCP tools', () => {
  const servers: { label: string; heading: string[]; load: () => Promise<Tool[]> }[] = [
    { label: 'gateway native tools', heading: gatewayHeadings, load: async () => listNativeTools() },
    { label: 'phantom-fleet server', heading: ['## `phantom-fleet`'], load: () => listOverMcp(createFleetServer() as never) },
    { label: 'phantom-docs server', heading: ['## `phantom-docs`'], load: () => listOverMcp(createDocsServer() as never) },
  ];

  for (const { label, heading, load } of servers) {
    describe(label, () => {
      const parts = heading.map(section);
      const names = parts.flatMap(p => p.names);
      const rows = new Map(parts.flatMap(p => [...p.rows]));

      it('has a row for every registered tool and no row for an unregistered one', async () => {
        const registered = (await load()).map(t => t.name);
        expect(registered.length).toBeGreaterThan(0);
        expect(registered.filter(n => !rows.has(n)), 'registered but missing from the doc').toEqual([]);
        expect([...rows.keys()].filter(n => !registered.includes(n)), 'in the doc but not registered').toEqual([]);
      });

      it('lists each tool once', () => {
        expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
      });

      it('rows carry the source description and the argument names', async () => {
        for (const tool of await load()) {
          const row = rows.get(tool.name);
          expect(row, `${tool.name} row`).toBeDefined();
          expect(clean(row!.description), `${tool.name} description drifted`).toBe(clean(tool.description ?? ''));
          expect(row!.inputs, `${tool.name} inputs drifted`).toBe(inputsOf(tool.inputSchema));
        }
      });
    });
  }
});
