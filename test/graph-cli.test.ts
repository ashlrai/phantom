import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphSnapshot } from '../src/core/graph/loader.js';

const loader = vi.hoisted(() => ({ loadGraph: vi.fn() }));
vi.mock('../src/core/graph/loader.js', () => loader);
import { cmdGraph } from '../src/cli/graph.js';

const COMMANDS = ['nodes', 'edges', 'status'] as const;
const SNAPSHOT: GraphSnapshot = {
  status: 'ready',
  nodes: [
    { id: 'repo:phantom', kind: 'repository', label: 'Phantom', metadata: { source: 'GRAPH-1' } },
    { id: 'repo:locus', kind: 'repository', label: 'Locus' },
  ],
  edges: [{ id: 'edge:1', from: 'repo:phantom', to: 'repo:locus', kind: 'depends-on' }],
};

describe('graph CLI', () => {
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    loader.loadGraph.mockResolvedValue(structuredClone(SNAPSHOT));
  });
  afterEach(() => vi.restoreAllMocks());

  function json(): Record<string, unknown> {
    expect(output).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
    const text = output.mock.calls[0]![0] as string;
    expect(text).not.toContain('\u001b');
    return JSON.parse(text) as Record<string, unknown>;
  }

  it.each(COMMANDS)('projects %s as one versioned JSON object', async (command) => {
    expect(await cmdGraph([command, '--json'])).toBe(0);
    expect(json()).toEqual({ schemaVersion: 1, command, status: 'ready',
      ...(command === 'status' ? { counts: { nodes: 2, edges: 1 } } : { [command]: SNAPSHOT[command] }) });
    expect(loader.loadGraph).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(COMMANDS)('allows --json before %s', async (command) => {
    expect(await cmdGraph(['--json', command])).toBe(0);
    expect(json()).toMatchObject({ command, status: 'ready' });
  });

  it.each(COMMANDS)('distinguishes a successfully loaded empty graph for %s', async (command) => {
    loader.loadGraph.mockResolvedValue({ status: 'ready', nodes: [], edges: [] });
    expect(await cmdGraph([command, '--json'])).toBe(0);
    expect(json()).toEqual({ schemaVersion: 1, command, status: 'ready',
      ...(command === 'status' ? { counts: { nodes: 0, edges: 0 } } : { [command]: [] }) });
  });

  it.each(COMMANDS)('reports unavailable %s with exit 1 and no fabricated data or counts', async (command) => {
    loader.loadGraph.mockResolvedValue({ status: 'unavailable' });
    expect(await cmdGraph([command, '--json'])).toBe(1);
    expect(json()).toEqual({ schemaVersion: 1, command, status: 'unavailable',
      error: { code: 'GRAPH_UNAVAILABLE', message: 'GRAPH-1 loader is not available in this build.' } });
    expect(loader.loadGraph).toHaveBeenCalledOnce();
  });

  it('uses the actual unavailable stub through the command boundary', async () => {
    const actual = await vi.importActual<typeof import('../src/core/graph/loader.js')>('../src/core/graph/loader.js');
    loader.loadGraph.mockImplementation(actual.loadGraph);
    expect(await cmdGraph(['status', '--json'])).toBe(1);
    expect(json()).toMatchObject({ status: 'unavailable', error: { code: 'GRAPH_UNAVAILABLE' } });
  });

  it.each([
    { args: [] }, { args: ['help'] }, { args: ['node'] }, { args: ['NODES'] },
    { args: ['--unknown'] }, { args: ['nodes', '--unknown'] },
    { args: ['nodes', '--json=true'] }, { args: ['nodes', 'edges'] },
    { args: ['status', 'status'] }, { args: ['edges', 'extra'] },
    { args: ['--json', 'nodes'] }, // A second --json is appended below.
    { args: ['nodes', '--help', '-h'] }, { args: ['nodes', '--help', '--help'] },
    { args: ['--help', '--unknown'] }, { args: ['bogus', '--help'] },
    { args: ['nodes', '--root', '/tmp/graph'] }, { args: ['nodes', '--'] },
    { args: [''] }, { args: [' nodes'] }, { args: ['nodes\n'] },
  ])('rejects invalid arguments $args before loading', async ({ args }) => {
    expect(await cmdGraph([...args, '--json'])).toBe(2);
    expect(json()).toMatchObject({ schemaVersion: 1, status: 'error', error: { code: 'GRAPH_USAGE' } });
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });

  it.each([
    { args: ['--help'] }, { args: ['-h'] }, { args: ['--help', '--json'] },
    ...COMMANDS.flatMap((command) => [
      { args: [command, '--help'] }, { args: [command, '-h'] },
      { args: ['--help', command] }, { args: [command, '--json', '--help'] },
    ]),
  ])('prints help for $args without loading', async ({ args }) => {
    expect(await cmdGraph(args)).toBe(0);
    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0]![0]).toContain('Usage: phm graph <nodes|edges|status> [--json]');
    expect(output.mock.calls[0]![0]).toContain('Exit codes: 0 success/help, 1 unavailable or loader failure, 2 invalid arguments.');
    expect(errors).not.toHaveBeenCalled();
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });

  it.each(COMMANDS)('handles rejected %s reads without leaking loader diagnostics or retrying', async (command) => {
    loader.loadGraph.mockRejectedValue(new Error('private diagnostic sentinel'));
    expect(await cmdGraph([command, '--json'])).toBe(1);
    expect(json()).toEqual({ schemaVersion: 1, command, status: 'error',
      error: { code: 'GRAPH_LOAD_FAILED', message: 'Could not load GRAPH-1 graph data.' } });
    expect(loader.loadGraph).toHaveBeenCalledOnce();
  });

  it('handles synchronous loader exceptions and non-Error rejections', async () => {
    loader.loadGraph.mockImplementationOnce(() => { throw 'private diagnostic sentinel'; });
    expect(await cmdGraph(['nodes', '--json'])).toBe(1);
    expect(json()).toMatchObject({ error: { code: 'GRAPH_LOAD_FAILED' } });
  });

  it.each([null, undefined, {}, { status: 'ready' }, { status: 'other', nodes: [], edges: [] },
    { status: 'ready', nodes: {}, edges: [] }, { status: 'ready', nodes: [], edges: null }])(
    'refuses a malformed loader result %j', async (result) => {
      loader.loadGraph.mockResolvedValue(result);
      expect(await cmdGraph(['status', '--json'])).toBe(1);
      expect(json()).toMatchObject({ status: 'error', error: { code: 'GRAPH_LOAD_FAILED' } });
    },
  );

  it('handles serialization failure before emitting any JSON fragment', async () => {
    const node: Record<string, unknown> = { id: 'cyclic' };
    node.self = node;
    loader.loadGraph.mockResolvedValue({ status: 'ready', nodes: [node], edges: [] });
    expect(await cmdGraph(['nodes', '--json'])).toBe(1);
    expect(json()).toMatchObject({ error: { code: 'GRAPH_LOAD_FAILED' } });
  });

  it('does not print a human success header when records cannot be serialized', async () => {
    loader.loadGraph.mockResolvedValue({ status: 'ready', nodes: [{ id: 'invalid', value: 1n }], edges: [] });
    expect(await cmdGraph(['nodes'])).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledExactlyOnceWith('graph: Could not load GRAPH-1 graph data.');
  });

  it.each(COMMANDS)('renders human-readable %s', async (command) => {
    expect(await cmdGraph([command])).toBe(0);
    expect(output.mock.calls[0]![0]).toBe(command === 'status'
      ? 'Graph: ready · 2 nodes · 1 edge' : `Graph ${command}: ${SNAPSHOT[command].length}`);
    if (command !== 'status') expect(JSON.parse(output.mock.calls[1]![0] as string)).toEqual(SNAPSHOT[command]);
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'failure', 'usage'])('puts human %s errors on stderr', async (kind) => {
    if (kind === 'unavailable') loader.loadGraph.mockResolvedValue({ status: 'unavailable' });
    if (kind === 'failure') loader.loadGraph.mockRejectedValue(new Error('private diagnostic sentinel'));
    expect(await cmdGraph(kind === 'usage' ? [] : ['status'])).toBe(kind === 'usage' ? 2 : 1);
    expect(output).not.toHaveBeenCalled();
    expect(errors.mock.calls[0]![0]).toMatch(/^graph: /);
    expect(errors.mock.calls.flat().join(' ')).not.toContain('private diagnostic sentinel');
  });

  it('documents the command in both human and agent discovery surfaces', async () => {
    const { AGENT_COMMANDS, cmdHelp } = await import('../src/cli/help.js');
    expect(AGENT_COMMANDS.find((entry) => entry.usage.startsWith('phm graph '))).toMatchObject({ safety: 'read' });
    expect(await cmdHelp(['graph'])).toBe(0);
    expect(output.mock.calls.flat().join('\n')).toContain('graph nodes|edges|status [--json]');
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });

  it.each(['bash', 'zsh'])('registers graph and its subcommands in %s completion', async (shell) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { TOP_LEVEL_COMMANDS, cmdCompletions } = await import('../src/cli/completions.js');
    expect(TOP_LEVEL_COMMANDS).toContain('graph');
    expect(await cmdCompletions([shell])).toBe(0);
    expect(stdout.mock.calls.map(([value]) => String(value)).join('')).toMatch(/graph\).*nodes.*edges.*status/);
  });
});
