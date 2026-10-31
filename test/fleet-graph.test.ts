import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { buildFleetGraph } from '../src/core/fleet/graph.js';
import { cmdFleet } from '../src/cli/fleet.js';

const queueDir = fileURLToPath(new URL('./fixtures/fleet-graph', import.meta.url));
const validate = new AjvJsonSchemaValidator().getValidator(JSON.parse(readFileSync(new URL('../schemas/fleet.v1.schema.json', import.meta.url), 'utf8')));
describe('fleet graph projection', () => {
  it('validates fixture topology, latest job state, deduplication and allowlisted output', async () => {
    const graph = await buildFleetGraph({ queueDir, now: () => new Date('2026-10-29T12:00:00Z') });
    expect(validate(graph).valid).toBe(true);
    expect(new Set(graph.nodes.map(n => n.kind))).toEqual(new Set(['leader', 'lane', 'slot', 'job', 'pr', 'resource']));
    expect(graph.nodes.find(n => n.id === 'job:RQ-DEMO')?.status).toBe('LAND');
    expect(new Set(graph.nodes.map(n => n.id)).size).toBe(graph.nodes.length);
    for (const e of graph.edges) {
      expect(graph.nodes.some(n => n.id === e.source)).toBe(true);
      expect(graph.nodes.some(n => n.id === e.target)).toBe(true);
    }
    expect(JSON.stringify(graph)).not.toMatch(/must-not-appear|untrusted prompt/);
    expect(graph.sources['leader-status.json']).toBe('unknown');
    expect(graph.sources['jobs.jsonl']).toBe('partial');
  });
  it('returns a valid unknown snapshot for absent sources and rejects relative roots', async () => {
    const graph = await buildFleetGraph({ queueDir: `${queueDir}/absent` });
    expect(validate(graph).valid).toBe(true);
    expect(graph.nodes).toHaveLength(1);
    expect(Object.values(graph.sources).every(s => s === 'unknown')).toBe(true);
    await expect(buildFleetGraph({ queueDir: 'relative' })).rejects.toThrow('absolute');
  });
  it('exposes schema-valid JSON through the fleet CLI', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdFleet(['graph', '--json', '--queue-dir', queueDir])).toBe(0);
      expect(validate(JSON.parse(log.mock.calls[0]![0] as string)).valid).toBe(true);
      expect(await cmdFleet(['graph', '--queue-dir', 'relative'])).toBe(2);
    } finally { log.mockRestore(); }
  });
});
