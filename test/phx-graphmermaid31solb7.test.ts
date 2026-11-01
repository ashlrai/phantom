import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFleetGraphSeed } from '../src/core/fleet/graph-seed.js';
import type { GraphSnapshot } from '../src/core/graph/loader.js';

vi.mock('../src/core/fleet/graph-seed.js', async (original) => ({
  ...await original<typeof import('../src/core/fleet/graph-seed.js')>(),
  seedFleetGraph: vi.fn(),
}));
import { seedFleetGraph } from '../src/core/fleet/graph-seed.js';
import { cmdGraph } from '../src/cli/graph.js';
import { renderMermaid, MermaidLimitError } from '../src/cli/graph-mermaid.js';

const reader = vi.mocked(seedFleetGraph);
const format = ['export', '--format', 'mermaid'];
const base: GraphSnapshot = {
  status: 'ready', complete: false,
  sources: { fleetJson: { state: 'malformed', path: '/private/path' }, seats: { state: 'loaded', count: 1 } },
  issues: [{ code: 'malformed', message: 'private detail', nodeIds: [] }],
  nodes: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }],
  edges: [{ from: 'a', to: 'b', kind: 'serves' }],
};

describe('graph Mermaid export', () => {
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reader.mockReset();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('passes real seeded records through the actual loader and retains partial evidence', async () => {
    const seed = buildFleetGraphSeed({
      fleet: { v: 1, lanes: [{ lane: 'codex' }], seats: [{ seat: 'missing', lane: 'local' }] },
      seats: [{ id: 'worker', engine: 'codex', label: 'Worker' }],
    });
    expect(seed.complete).toBe(false);
    reader.mockResolvedValue(seed);
    expect(await cmdGraph(format)).toBe(0);
    expect(reader).toHaveBeenCalledExactlyOnceWith();
    expect(output).toHaveBeenCalledOnce();
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain(`%% Source complete: false; recorded issues: ${seed.issues.length}`);
    expect(text).toContain('%% Sources: fleet.json=loaded; seats=loaded');
    expect(text).toContain('["Worker"]');
    expect(text).toContain('-->|"serves"|');
    expect(text).not.toContain('unresolved-edge');
    expect(errors).not.toHaveBeenCalled();
  });

  it('escapes all Mermaid delimiters, entities, newlines and HTML in labels and edge kinds', () => {
    const attack = 'x"]\nattack-->victim; <script>&#34; | (`)';
    const text = renderMermaid({ ...base, nodes: [{ id: 'a', label: attack }, { id: 'b' }],
      edges: [{ from: 'a', to: 'b', kind: attack }] }, { from: null, to: null });
    expect(text.split('\n')).toHaveLength(7);
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('attack-->victim');
    expect(text).toContain('#34;#93;#10;attack#45;#45;#62;victim#59; #60;script#62;#38;#35;34#59;');
    expect(text.split('\n').filter((line) => line.includes(' -->|'))).toHaveLength(1);
  });

  it('sorts nodes and edges independent of input order and makes missing endpoints explicit', () => {
    const graph: GraphSnapshot = { ...base, nodes: [{ id: 'b', label: 'Beta' }, { id: 'a', label: 'Alpha' }],
      edges: [{ from: 'z', to: 'a', kind: 'reviews' }, { from: 'a', to: 'b', kind: 'serves' }] };
    const text = renderMermaid(graph, { from: null, to: null });
    expect(text).toBe(renderMermaid({ ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() }, { from: null, to: null }));
    expect(text).toContain('missing endpoints: 1');
    expect(text).toContain('n2["Missing node#58; z"]');
    expect(text).toContain('n2 -->|"reviews"| n0');
    expect(text).not.toContain('/private/path');
    expect(text).not.toContain('private detail');
  });

  it('applies exact endpoint filters to edges and includes only their endpoints', async () => {
    const seed = buildFleetGraphSeed({ fleet: { v: 1, lanes: [{ lane: 'codex' }], repos: [{ repo: 'example/repo' }] }, seats: [] });
    reader.mockResolvedValue(seed);
    expect(await cmdGraph([...format, '--to=lane:codex'])).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('filtered edges and endpoints');
    expect(text).toContain('Lane codex');
    expect(text).not.toContain('example');
    expect(text.match(/ -->\|/g)).toHaveLength(1);
  });

  it('distinguishes unknown source quality and an empty selection', () => {
    const text = renderMermaid({ status: 'ready', nodes: [], edges: [] }, { from: 'none', to: null });
    expect(text).toContain('Source complete: unknown; recorded issues: unknown');
    expect(text).toContain('fleet.json=unknown; seats=unknown');
    expect(text).toContain('missing endpoints: 0');
  });

  it('fails without output when the node, edge, or byte limit is exceeded', () => {
    const nodes = Array.from({ length: 501 }, (_, i) => ({ id: String(i) }));
    expect(() => renderMermaid({ ...base, nodes, edges: [] }, { from: null, to: null })).toThrow(/500 node limit/);
    const edges = Array.from({ length: 1001 }, () => ({ from: 'a', to: 'b', kind: 'x' }));
    expect(() => renderMermaid({ ...base, edges }, { from: null, to: null })).toThrow(/1000 edge limit/);
    expect(() => renderMermaid({ ...base, nodes: [{ id: 'a', label: '<'.repeat(70000) }], edges: [] }, { from: null, to: null })).toThrow(MermaidLimitError);
  });

  it('reports export limits on stderr without printing a partial graph', async () => {
    const seed = buildFleetGraphSeed({ fleet: { v: 1, repos: Array.from({ length: 501 }, (_, i) => ({ repo: `r${i}` })) }, seats: [] });
    reader.mockResolvedValue(seed);
    expect(await cmdGraph(format)).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(errors.mock.calls[0]![0]).toContain('500 node limit');
  });

  it.each([
    ['export'], ['export', '--format', 'json'], ['export', '--format', 'mermaid', '--json'],
    ['export', '--format', 'mermaid', '--format', 'mermaid'], ['export', '--format', 'mermaid', '--from'],
  ])('rejects invalid arguments %j before loading', async (...args) => {
    expect(await cmdGraph(args)).toBe(2);
    expect(reader).not.toHaveBeenCalled();
  });

  it('documents a handoff example in help without loading', async () => {
    expect(await cmdGraph(['export', '--help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('phm graph export --format mermaid > handoff-graph.mmd');
    expect(output.mock.calls[0]![0]).toContain('n0 -->|"contains"| n1');
    expect(reader).not.toHaveBeenCalled();
  });
});
