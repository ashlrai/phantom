import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listNativeTools } from '../src/core/mcp-native.js';
import { registerFleetNativeTools } from '../src/core/mcp-native-fleet.js';

// Mirror gateway registration, then list only. No handlers or live services run.
registerFleetNativeTools();
const tools = listNativeTools().filter(({ name }) =>
  name.startsWith('phantom_agent_bus_') || name.startsWith('intent_'));
const doc = readFileSync(join(process.cwd(), 'docs/MCP-BUS-INTENT-INPUTS.md'), 'utf8');

interface Schema { properties?: Record<string, unknown>; required?: string[] }
interface Row { name: string; required: string[]; optional: string[] }

function argumentsIn(cell: string): string[] {
  if (cell === 'none') return [];
  if (!/^`[A-Za-z][A-Za-z0-9_]*`(?:, `[A-Za-z][A-Za-z0-9_]*`)*$/.test(cell)) {
    throw new Error(`Invalid argument cell: ${cell}`);
  }
  return cell.split(', ').map(value => value.slice(1, -1));
}

function rowsIn(markdown: string): Row[] {
  return markdown.split('\n').filter(line => /^\|\s*`/.test(line)).map(line => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length !== 4 || !/^`[a-z0-9_]+`$/.test(cells[0] ?? '') || !cells[3]) {
      throw new Error(`Invalid tool row: ${line}`);
    }
    return { name: cells[0]!.slice(1, -1), required: argumentsIn(cells[1]!), optional: argumentsIn(cells[2]!) };
  });
}

function checkContract(markdown: string): void {
  const rows = rowsIn(markdown);
  expect(tools.length).toBeGreaterThan(0);
  // Compare arrays before mapping: duplicate rows and extra/removed tools fail.
  expect(rows.map(row => row.name).sort(), 'tool coverage').toEqual(tools.map(tool => tool.name).sort());
  for (const tool of tools) {
    const schema = tool.inputSchema as Schema;
    const required = schema.required ?? [];
    const optional = Object.keys(schema.properties ?? {}).filter(name => !required.includes(name));
    const row = rows.find(candidate => candidate.name === tool.name)!;
    expect([...row.required].sort(), `${tool.name} required`).toEqual([...required].sort());
    expect([...row.optional].sort(), `${tool.name} optional`).toEqual(optional.sort());
  }
}

function changeRow(markdown: string, name: string, transform: (line: string) => string): string {
  const prefix = `| \`${name}\` |`;
  const matching = markdown.split('\n').filter(line => line.startsWith(prefix));
  expect(matching, `mutation target ${name}`).toHaveLength(1);
  return markdown.replace(matching[0]!, transform(matching[0]!));
}

describe('preserved native bus/intent input contract', () => {
  it('matches exact current registrations, argument names and schema requiredness', () => {
    checkContract(doc);
  });

  it.each(tools.map(tool => tool.name))('detects an omitted %s row', name => {
    expect(() => checkContract(changeRow(doc, name, () => ''))).toThrow('tool coverage');
  });

  it('detects an extra obsolete tool', () => {
    expect(() => checkContract(`${doc}\n| \`intent_removed_fake\` | none | none | Read fake data. |`))
      .toThrow('tool coverage');
  });

  it.each(tools.map(tool => tool.name))('detects a duplicate %s row', name => {
    expect(() => checkContract(changeRow(doc, name, line => `${line}\n${line}`))).toThrow('tool coverage');
  });

  // Mutate every registered argument, in each applicable direction, rather
  // than testing only a hand-picked required field from one family.
  for (const tool of tools) {
    const schema = tool.inputSchema as Schema;
    for (const arg of Object.keys(schema.properties ?? {})) {
      const required = (schema.required ?? []).includes(arg);
      it(`detects ${tool.name}.${arg} moved to ${required ? 'optional' : 'required'}`, () => {
        const mutated = changeRow(doc, tool.name, line => {
          const cells = line.split('|');
          const from = required ? 2 : 3;
          const to = required ? 3 : 2;
          const remaining = argumentsIn(cells[from]!.trim()).filter(name => name !== arg);
          const moved = [...argumentsIn(cells[to]!.trim()), arg];
          const format = (args: string[]): string => args.length ? args.map(name => `\`${name}\``).join(', ') : 'none';
          cells[from] = ` ${format(remaining)} `;
          cells[to] = ` ${format(moved)} `;
          return cells.join('|');
        });
        expect(() => checkContract(mutated)).toThrow(`${tool.name} required`);
      });
    }
  }

  it.each([
    ['missing required argument', 'intent_get', (line: string) => line.replace('`id` | none', 'none | none')],
    ['extra argument on empty schema', 'phantom_agent_bus_status', (line: string) => line.replace('none | none', 'none | `fake`')],
    ['renamed optional argument', 'phantom_agent_bus_read', (line: string) => line.replace('`after`', '`cursor`')],
    ['duplicated required argument', 'intent_get', (line: string) => line.replace('`id` |', '`id`, `id` |')],
    ['duplicated optional argument', 'intent_list', (line: string) => line.replace('`status` |', '`status`, `status` |')],
    ['malformed argument cell', 'intent_get', (line: string) => line.replace('`id` |', 'id |')],
  ] as const)('detects %s', (_label, name, transform) => {
    expect(() => checkContract(changeRow(doc, name, transform))).toThrow();
  });
});
