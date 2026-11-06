import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolve, type ToolGraph } from '../src/core/toolgraph/index.js';

const graph = JSON.parse(readFileSync(new URL('../src/core/toolgraph/graph.json', import.meta.url), 'utf8')) as ToolGraph;
const env = { PHANTOM_TOOLGRAPH: '1' };
const availableTools = new Set(Object.keys(graph.tools));

describe('toolgraph discovery', () => {
  it('is disabled by default and does not inspect configuration', () => {
    expect(resolve('unknown', { availableTools, env: {} })).toEqual({ status: 'disabled', tools: [] });
  });
  it('resolves deploy-feature with its full dependency closure and permissions', () => {
    const result = resolve('deploy-feature', { availableTools, env });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error('Expected complete resolution');
    expect(result.capabilities).toEqual(['inspect-repo', 'check-env', 'validate', 'deploy', 'verify-prod']);
    expect(result.tools.map(tool => tool.id).sort()).toEqual([...availableTools].sort());
    for (const tool of result.tools) expect(tool.permissions).toEqual(graph.tools[tool.id].permissions);
  });
  it('withholds partial sets and names the capability when the only verify tool is absent', () => {
    const inventory = new Set(availableTools);
    inventory.delete('mcp.playwright-browser-navigate');
    expect(resolve('deploy-feature', { availableTools: inventory, env })).toMatchObject({
      status: 'incomplete', tools: [], missingCapabilities: ['verify-prod'],
    });
  });
  it('finds the exact minimum cover rather than a greedy redundant set', () => {
    const custom: ToolGraph = {
      capabilities: {
        a: { requires: ['b', 'c'], tools: ['ab', 'ac', 'a'] },
        b: { requires: [], tools: ['ab', 'b'] },
        c: { requires: [], tools: ['ac', 'c'] },
      },
      tools: Object.fromEntries(['ab', 'ac', 'a', 'b', 'c'].map(id => [id, { permissions: ['read'] }])),
      tasks: { task: ['a'] },
    };
    const result = resolve('task', { graph: custom, availableTools: new Set(Object.keys(custom.tools)), env });
    expect(result.tools).toHaveLength(2);
    if (result.status !== 'complete') throw new Error('Expected complete resolution');
    for (const tool of result.tools) {
      const remaining = new Set(result.tools.filter(candidate => candidate !== tool).map(candidate => candidate.id));
      expect(resolve('task', { graph: custom, availableTools: remaining, env }).status).toBe('incomplete');
    }
  });
  it('prefers lower permissions among equally small covers', () => {
    const custom = structuredClone(graph);
    custom.tools['reader'] = { permissions: ['read'] };
    custom.capabilities['check-env'].tools.push('reader');
    const result = resolve('deploy-feature', { graph: custom, availableTools: new Set([...availableTools, 'reader']), env });
    expect(result.tools.map(tool => tool.id)).toContain('reader');
    expect(result.tools.map(tool => tool.id)).not.toContain('cli.phm-doctor');
  });
  it('rejects cycles including disconnected cycles', () => {
    const custom = structuredClone(graph);
    custom.capabilities['cycle'] = { requires: ['cycle'], tools: [] };
    expect(() => resolve('deploy-feature', { graph: custom, availableTools, env })).toThrow('Toolgraph cycle at capability: cycle');
    custom.capabilities['cycle'].requires = [];
    custom.capabilities['inspect-repo'].requires.push('verify-prod');
    expect(() => resolve('deploy-feature', { graph: custom, availableTools, env })).toThrow(/cycle/);
  });
  it('rejects unknown references and missing permission annotations', () => {
    const custom = structuredClone(graph);
    custom.tools['cli.git-status'].permissions = [];
    expect(() => resolve('deploy-feature', { graph: custom, availableTools, env })).toThrow(/permissions/);
    expect(() => resolve('unknown', { availableTools, env })).toThrow(/Unknown task/);
    custom.tools['cli.git-status'].permissions = ['read'];
    custom.capabilities['deploy'].requires.push('unknown');
    expect(() => resolve('deploy-feature', { graph: custom, availableTools, env })).toThrow(/Unknown capability/);
  });
});
