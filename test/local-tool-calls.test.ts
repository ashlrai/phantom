/**
 * local-tool-calls.test.ts — local-model tool-use parity (tool-call adapter).
 *
 * OMLX/MLX-served local models return tool calls in dialects hosted lanes
 * never see: `<tool_call>` markup frames (JSON, Qwen3-Coder XML, GLM
 * arg_key/arg_value), Mistral `[TOOL_CALLS]…[ARGS]` sections, and bare JSON
 * in content when the server-side parser misses. src/core/run/tool-calls.ts
 * normalizes all of it into the canonical {id,name,arguments} shape, and
 * provider-client.ts wires it into every local endpoint path (OpenAI-compat
 * chat/chatStream, Ollama chat/chatStream) behind the same gates as M118:
 * structured calls win, the fallback fires only when tools were advertised,
 * and a call's name MUST be in the advertised set.
 *
 * Test groups:
 *   1. UNIT — the dialect parsers + request-side spec normalization.
 *   2. LOOPBACK — a real 127.0.0.1 HTTP server standing in for an OMLX-style
 *      endpoint: two-turn tool loop (markup call → tool result → final text),
 *      wire-spec scrubbing, replay fidelity, and the no-tools gate.
 *   3. STREAMING — SSE tool_call deltas (index-less + object arguments) and
 *      content-embedded markup accumulated across chunks.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildOllamaClient,
  buildOpenAICompatibleClient,
  parseContentToolCalls,
  toolNamesFromSpecs,
} from '../src/core/run/provider-client.js';
import {
  normalizeStreamedToolCallFragments,
  parseEmbeddedToolCalls,
  parseOpenAIToolCalls,
  parseOllamaToolCalls,
  toOpenAIToolSpecs,
} from '../src/core/run/tool-calls.js';
import type { ChatMessage } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
    // Internal-only fields an ExecutableToolSpec carries — must never hit the wire.
    name: 'read_file',
    safety: 'read',
    fn: async () => 'unused',
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
    },
    name: 'write_file',
    safety: 'write',
    fn: async () => 'unused',
  },
];

const TOOL_NAMES = toolNamesFromSpecs(TOOLS);

// ---------------------------------------------------------------------------
// 1. UNIT — structured parsers
// ---------------------------------------------------------------------------

describe('parseOpenAIToolCalls', () => {
  it('parses nested function calls and JSON-string arguments', () => {
    const calls = parseOpenAIToolCalls({
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a"}' } },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls![0]).toMatchObject({ id: 'call_1', name: 'read_file' });
    expect(calls![0]!.arguments).toEqual({ path: '/a' });
  });

  it('parses flat entries and object arguments (local-server variants)', () => {
    const calls = parseOpenAIToolCalls({
      tool_calls: [{ name: 'write_file', arguments: { path: '/b', content: 'x' } }],
    });
    expect(calls).toHaveLength(1);
    expect(calls![0]!.name).toBe('write_file');
    expect(calls![0]!.arguments).toEqual({ path: '/b', content: 'x' });
    expect(calls![0]!.id).toMatch(/^call_0$/);
  });

  it('parses legacy function_call', () => {
    const calls = parseOpenAIToolCalls({
      function_call: { name: 'read_file', arguments: '{"path":"/c"}' },
    });
    expect(calls).toHaveLength(1);
    expect(calls![0]!.name).toBe('read_file');
  });

  it('skips nameless/malformed entries', () => {
    expect(
      parseOpenAIToolCalls({ tool_calls: [{ function: { arguments: '{}' } }, 'junk', null] }),
    ).toBeUndefined();
  });
});

describe('parseOllamaToolCalls', () => {
  it('parses Ollama {function:{name,arguments}} shape', () => {
    const calls = parseOllamaToolCalls({
      tool_calls: [{ function: { name: 'read_file', arguments: { path: '/o' } } }],
    });
    expect(calls).toHaveLength(1);
    expect(calls![0]!.name).toBe('read_file');
    expect(calls![0]!.arguments).toEqual({ path: '/o' });
    expect(calls![0]!.id).toBe('call_0');
  });
});

// ---------------------------------------------------------------------------
// 2. UNIT — embedded markup dialects (the OMLX/mlx-lm gap)
// ---------------------------------------------------------------------------

describe('parseEmbeddedToolCalls — <tool_call> JSON frame (json_tools/qwen35)', () => {
  it('parses <tool_call>{"name","arguments"}</tool_call> and strips the frame', () => {
    const content =
      'Let me read that.\n<tool_call>\n{"name":"read_file","arguments":{"path":"/x.ts"}}\n</tool_call>';
    const result = parseEmbeddedToolCalls(content, TOOL_NAMES);
    expect(result).toBeDefined();
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls[0]!.name).toBe('read_file');
    expect(result!.toolCalls[0]!.arguments).toEqual({ path: '/x.ts' });
    expect(result!.toolCalls[0]!.id).toMatch(/^call_tag_0_read_fil/);
    expect(result!.cleanedContent).toBe('Let me read that.');
  });

  it('parses multiple <tool_call> frames in one response', () => {
    const content =
      '<tool_call>{"name":"read_file","arguments":{"path":"/a"}}</tool_call>\n' +
      '<tool_call>{"name":"write_file","arguments":{"path":"/b","content":"y"}}</tool_call>';
    const result = parseEmbeddedToolCalls(content, TOOL_NAMES);
    expect(result!.toolCalls.map((c) => c.name)).toEqual(['read_file', 'write_file']);
    expect(result!.cleanedContent).toBe('');
  });

  it('parses a <tool_call> array payload', () => {
    const content =
      '<tool_call>[{"name":"read_file","arguments":{"path":"/a"}},{"name":"read_file","arguments":{"path":"/b"}}]</tool_call>';
    const result = parseEmbeddedToolCalls(content, TOOL_NAMES);
    expect(result!.toolCalls).toHaveLength(2);
  });

  it('rejects frames whose name is not advertised', () => {
    const content = '<tool_call>{"name":"exfiltrate","arguments":{}}</tool_call>';
    expect(parseEmbeddedToolCalls(content, TOOL_NAMES)).toBeUndefined();
  });
});

describe('parseEmbeddedToolCalls — Qwen3-Coder XML frame', () => {
  it('parses <function=name><parameter=k>v</parameter></function>', () => {
    const content =
      '<tool_call>\n<function=write_file>\n<parameter=path>\n/out.ts\n</parameter>\n' +
      '<parameter=content>\nexport const z = 3;\n</parameter>\n</function>\n</tool_call>';
    const result = parseEmbeddedToolCalls(content, TOOL_NAMES);
    expect(result).toBeDefined();
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls[0]!.name).toBe('write_file');
    expect(result!.toolCalls[0]!.arguments).toEqual({
      path: '/out.ts',
      content: 'export const z = 3;',
    });
    expect(result!.cleanedContent).toBe('');
  });

  it('coerces JSON-looking parameter values', () => {
    const content =
      '<tool_call><function=read_file><parameter=path>{"a": 1}</parameter></function></tool_call>';
    const result = parseEmbeddedToolCalls(content, TOOL_NAMES);
    expect(result!.toolCalls[0]!.arguments).toEqual({ path: { a: 1 } });
  });
});

describe('parseEmbeddedToolCalls — GLM framed args', () => {
  it('parses name<arg_key>k</arg_key><arg_value>v</arg_value>', () => {
    const content =
      '<tool_call>read_file<arg_key>path</arg_key><arg_value>/g.ts</arg_value></tool_call>';
    const result = parseEmbeddedToolCalls(content, TOOL_NAMES);
    expect(result).toBeDefined();
    expect(result!.toolCalls[0]!.name).toBe('read_file');
    expect(result!.toolCalls[0]!.arguments).toEqual({ path: '/g.ts' });
  });
});

describe('parseEmbeddedToolCalls — Mistral [TOOL_CALLS] section', () => {
  it('parses [TOOL_CALLS]name [ARGS]{json}', () => {
    const content = '[TOOL_CALLS]read_file [ARGS]{"path":"/m.ts"}';
    const result = parseEmbeddedToolCalls(content, TOOL_NAMES);
    expect(result).toBeDefined();
    expect(result!.toolCalls[0]!.name).toBe('read_file');
    expect(result!.toolCalls[0]!.arguments).toEqual({ path: '/m.ts' });
    expect(result!.cleanedContent).toBe('');
  });
});

describe('parseEmbeddedToolCalls — safety + fallback ordering', () => {
  it('structured-shaped prose JSON still goes through the M118 path', () => {
    const content = 'Sure.\n{"name":"read_file","arguments":{"path":"/p"}}';
    const result = parseEmbeddedToolCalls(content, TOOL_NAMES);
    expect(result).toBeDefined();
    expect(result!.toolCalls[0]!.name).toBe('read_file');
    expect(result!.toolCalls[0]!.id).toMatch(/^call_content_0_read_fil/);
  });

  it('plain prose is never a tool call', () => {
    expect(parseEmbeddedToolCalls('The answer is 42.', TOOL_NAMES)).toBeUndefined();
    expect(parseEmbeddedToolCalls('', TOOL_NAMES)).toBeUndefined();
    expect(parseEmbeddedToolCalls('{"name":"read_file"}', new Set())).toBeUndefined();
  });

  it('unparseable <tool_call> inner falls through without inventing calls', () => {
    const content = '<tool_call>not json at all</tool_call>';
    expect(parseEmbeddedToolCalls(content, TOOL_NAMES)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. UNIT — request-side normalization
// ---------------------------------------------------------------------------

describe('toOpenAIToolSpecs', () => {
  it('projects ExecutableToolSpec internals off the wire', () => {
    const wire = JSON.parse(JSON.stringify(toOpenAIToolSpecs(TOOLS))) as Array<
      Record<string, unknown>
    >;
    expect(wire).toHaveLength(2);
    for (const spec of wire) {
      expect(Object.keys(spec).sort()).toEqual(['function', 'type']);
      expect(spec['type']).toBe('function');
      const fn = spec['function'] as Record<string, unknown>;
      expect(Object.keys(fn).sort()).toEqual(['description', 'name', 'parameters']);
    }
    // fn / safety / top-level name must not survive serialization.
    const raw = JSON.stringify(toOpenAIToolSpecs(TOOLS));
    expect(raw).not.toContain('"fn"');
    expect(raw).not.toContain('"safety"');
    expect(raw).not.toContain('"read_file","safety"');
  });

  it('wraps bare ToolSpec {name,…} entries', () => {
    const wire = toOpenAIToolSpecs([{ name: 'grep', description: 'search', parameters: { type: 'object' } }]) as Array<
      { type: string; function: { name: string } }
    >;
    expect(wire[0]!.type).toBe('function');
    expect(wire[0]!.function.name).toBe('grep');
  });

  it('passes through unrecognised entries unchanged', () => {
    const odd = { custom: true };
    expect(toOpenAIToolSpecs([odd])).toEqual([odd]);
  });
});

describe('normalizeStreamedToolCallFragments', () => {
  it('finalizes accumulated fragments and parses JSON-string arguments', () => {
    // The SSE loop accumulates deltas into one fragment per call first;
    // this helper only does the final JSON coercion + id backfill.
    const calls = normalizeStreamedToolCallFragments([
      { id: 'call_s1', name: 'read_file', argsStr: '{"path":"/s"}' },
      { id: '', name: 'write_file', argsStr: '{"path":"/w"}' },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls![0]).toMatchObject({ id: 'call_s1', name: 'read_file' });
    expect(calls![0]!.arguments).toEqual({ path: '/s' });
    expect(calls![1]!.id).toBe('call_stream_1');
  });

  it('skips nameless fragments and keeps unparseable args verbatim', () => {
    const calls = normalizeStreamedToolCallFragments([
      { id: '', name: '', argsStr: '{"x":1}' },
      { id: 'c2', name: 'read_file', argsStr: '{bad json' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls![0]!.arguments).toBe('{bad json');
  });
});

// ---------------------------------------------------------------------------
// 4. LOOPBACK — real 127.0.0.1 HTTP server as the mock local endpoint
// ---------------------------------------------------------------------------

type RecordedRequest = {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
};

function completion(message: Record<string, unknown>, finish = 'stop') {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 0,
    model: 'mock-local',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

function sseResponse(chunks: string[]): string {
  return chunks.map((c) => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n';
}

describe('loopback mock endpoint — OMLX-style tool loop', () => {
  let server: Server;
  let baseUrl: string;
  const requests: RecordedRequest[] = [];
  // Scripted responder: each POST /v1/chat/completions gets the next reply.
  let replies: Array<Record<string, unknown> | string> = [];
  let requestCount = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        requests.push({ url: req.url ?? '', body, headers: req.headers });
        const reply = replies[Math.min(requestCount, replies.length - 1)];
        requestCount += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function reset(repliesArg: Array<Record<string, unknown> | string>) {
    requests.length = 0;
    requestCount = 0;
    replies = repliesArg;
  }

  it('turn 1: <tool_call> markup in content → normalized toolCalls + clean content', async () => {
    reset([
      completion({
        role: 'assistant',
        content:
          'I will inspect the file first.\n<tool_call>\n{"name":"read_file","arguments":{"path":"/repo/a.ts"}}\n</tool_call>',
      }),
    ]);

    const client = buildOpenAICompatibleClient(baseUrl, '', 'mock-omlx', true);
    const result = await client.chat([{ role: 'user', content: 'read /repo/a.ts' }], TOOLS);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe('read_file');
    expect(result.toolCalls![0]!.arguments).toEqual({ path: '/repo/a.ts' });
    expect(result.content).toBe('I will inspect the file first.');

    // Wire check: tools advertised in canonical OpenAI shape — no fn/safety/name.
    const sentTools = requests[0]!.body['tools'] as Array<Record<string, unknown>>;
    expect(sentTools).toHaveLength(2);
    expect(Object.keys(sentTools[0]!).sort()).toEqual(['function', 'type']);
    expect(JSON.stringify(sentTools)).not.toContain('"safety"');
    expect(sentTools[0]!.function).toMatchObject({ name: 'read_file' });
  });

  it('turn 2: assistant toolCalls + tool result replay → final text', async () => {
    reset([
      completion({ role: 'assistant', content: 'done — file was empty' }),
    ]);

    const client = buildOpenAICompatibleClient(baseUrl, '', 'mock-omlx', true);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'read /repo/a.ts' },
      {
        role: 'assistant',
        content: 'I will inspect the file first.',
        toolCalls: [{ id: 'call_tag_0_read_fil', name: 'read_file', arguments: { path: '/repo/a.ts' } }],
      },
      { role: 'tool', toolCallId: 'call_tag_0_read_fil', name: 'read_file', content: 'export {}' },
    ];
    const result = await client.chat(messages, TOOLS);

    expect(result.content).toBe('done — file was empty');
    expect(result.toolCalls).toBeUndefined();

    // The endpoint saw a valid replay: assistant tool_calls + matching tool result.
    const sent = requests[0]!.body['messages'] as Array<Record<string, unknown>>;
    const assistant = sent.find((m) => m['role'] === 'assistant')!;
    const toolCalls = assistant['tool_calls'] as Array<Record<string, unknown>>;
    expect(toolCalls[0]).toMatchObject({ id: 'call_tag_0_read_fil', type: 'function' });
    const fn = toolCalls[0]!['function'] as Record<string, unknown>;
    // OpenAI wire shape: arguments is a JSON STRING.
    expect(typeof fn['arguments']).toBe('string');
    expect(JSON.parse(fn['arguments'] as string)).toEqual({ path: '/repo/a.ts' });
    const toolMsg = sent.find((m) => m['role'] === 'tool')!;
    expect(toolMsg['tool_call_id']).toBe('call_tag_0_read_fil');
    expect(toolMsg['name']).toBe('read_file');
  });

  it('structured tool_calls beat content markup (native path safety)', async () => {
    reset([
      completion(
        {
          role: 'assistant',
          content: '<tool_call>{"name":"write_file","arguments":{"path":"/evil","content":"x"}}</tool_call>',
          tool_calls: [
            {
              id: 'call_native',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"/real"}' },
            },
          ],
        },
        'tool_calls',
      ),
    ]);

    const client = buildOpenAICompatibleClient(baseUrl, '', 'mock-omlx', true);
    const result = await client.chat([{ role: 'user', content: 'go' }], TOOLS);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.id).toBe('call_native');
    expect(result.toolCalls![0]!.name).toBe('read_file');
  });

  it('no fallback when tools were not advertised (supportsTools=false)', async () => {
    reset([
      completion({
        role: 'assistant',
        content: '<tool_call>{"name":"read_file","arguments":{"path":"/x"}}</tool_call>',
      }),
    ]);

    const client = buildOpenAICompatibleClient(baseUrl, '', 'mock-omlx', false);
    const result = await client.chat([{ role: 'user', content: 'go' }], TOOLS);

    // Tools were supplied but NOT advertised — markup must stay content.
    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toContain('<tool_call>');
    expect(requests[0]!.body['tools']).toBeUndefined();
  });

  it('no Authorization header is sent to a keyless local endpoint', async () => {
    reset([completion({ role: 'assistant', content: 'hi' })]);
    const client = buildOpenAICompatibleClient(baseUrl, '', 'mock-omlx', true);
    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers['authorization']).toBeUndefined();
  });
});

describe('loopback mock endpoint — Ollama dialect', () => {
  let server: Server;
  let baseUrl: string;
  const bodies: Array<Record<string, unknown>> = [];
  let replies: Array<Record<string, unknown>> = [];
  let requestCount = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        bodies.push(body);
        const reply = replies[Math.min(requestCount, replies.length - 1)];
        requestCount += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('Ollama native tool_calls parse; embedded <tool_call> content also normalizes', async () => {
    bodies.length = 0;
    requestCount = 0;
    replies = [
      // Turn 1: model emits markup in content (no structured tool_calls).
      {
        model: 'mock',
        message: {
          role: 'assistant',
          content: '<tool_call>{"name":"read_file","arguments":{"path":"/o.ts"}}</tool_call>',
        },
        done: true,
        prompt_eval_count: 5,
        eval_count: 9,
      },
      // Turn 2: final text after the tool result.
      {
        model: 'mock',
        message: { role: 'assistant', content: 'read complete' },
        done: true,
        prompt_eval_count: 8,
        eval_count: 4,
      },
    ];

    const client = buildOllamaClient(baseUrl, 'mock-model', true);

    const r1 = await client.chat([{ role: 'user', content: 'read /o.ts' }], TOOLS);
    expect(r1.toolCalls).toHaveLength(1);
    expect(r1.toolCalls![0]!.name).toBe('read_file');
    expect(r1.toolCalls![0]!.arguments).toEqual({ path: '/o.ts' });
    expect(r1.content).toBe('');

    // Ollama wire: tools are OpenAI-shaped with no internal fields.
    const sentTools = bodies[0]!['tools'] as Array<Record<string, unknown>>;
    expect(JSON.stringify(sentTools)).not.toContain('"safety"');
    expect(sentTools[0]).toMatchObject({ type: 'function' });

    // Turn 2 replay: Ollama wants arguments as a structured OBJECT.
    const r2 = await client.chat(
      [
        { role: 'user', content: 'read /o.ts' },
        {
          role: 'assistant',
          content: '',
          toolCalls: r1.toolCalls,
        },
        { role: 'tool', toolCallId: r1.toolCalls![0]!.id, name: 'read_file', content: 'data' },
      ],
      TOOLS,
    );
    expect(r2.content).toBe('read complete');

    const sentMessages = bodies[1]!['messages'] as Array<Record<string, unknown>>;
    const assistant = sentMessages.find((m) => m['role'] === 'assistant')!;
    const replayed = (assistant['tool_calls'] as Array<Record<string, unknown>>)[0]!;
    const replayFn = replayed['function'] as Record<string, unknown>;
    expect(replayFn['arguments']).toEqual({ path: '/o.ts' });
    const toolMsg = sentMessages.find((m) => m['role'] === 'tool')!;
    expect(toolMsg['tool_call_id']).toBe(r1.toolCalls![0]!.id);
  });
});

// ---------------------------------------------------------------------------
// 5. STREAMING — SSE deltas + embedded markup over a real loopback server
// ---------------------------------------------------------------------------

describe('loopback mock endpoint — SSE streaming', () => {
  let server: Server;
  let baseUrl: string;
  let mode: 'deltas' | 'markup' = 'deltas';
  const bodies: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        res.setHeader('Content-Type', 'text/event-stream');
        if (mode === 'deltas') {
          res.end(
            sseResponse([
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_st', function: { name: 'read_file', arguments: '' } }] } }] }),
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/st' } }] } }] }),
              // Second parallel call arrives WITHOUT index — keyed by id.
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'call_st2', function: { name: 'write_file', arguments: '{"path":"/w","content":"z"}' } }] } }] }),
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
            ]),
          );
        } else {
          const markup =
            '<tool_call>{"name":"read_file","arguments":{"path":"/m.ts"}}</tool_call>';
          const half = Math.floor(markup.length / 2);
          res.end(
            sseResponse([
              JSON.stringify({ choices: [{ delta: { content: markup.slice(0, half) } }] }),
              JSON.stringify({ choices: [{ delta: { content: markup.slice(half) } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            ]),
          );
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('assembles streamed tool_call deltas (index + id keyed, object args)', async () => {
    mode = 'deltas';
    bodies.length = 0;
    const client = buildOpenAICompatibleClient(baseUrl, '', 'mock-omlx', true);
    const result = await client.chatStream!(
      [{ role: 'user', content: 'go' }],
      TOOLS,
      () => {},
    );
    expect(result.toolCalls).toHaveLength(2);
    const read = result.toolCalls!.find((c) => c.name === 'read_file')!;
    const write = result.toolCalls!.find((c) => c.name === 'write_file')!;
    expect(read.id).toBe('call_st');
    expect(read.arguments).toEqual({ path: '/st.ts' });
    expect(write.id).toBe('call_st2');
    expect(write.arguments).toEqual({ path: '/w', content: 'z' });
    // tools on the wire are normalized
    expect(JSON.stringify(bodies[0]!['tools'])).not.toContain('"safety"');
  });

  it('falls back to embedded parse on accumulated SSE content', async () => {
    mode = 'markup';
    const client = buildOpenAICompatibleClient(baseUrl, '', 'mock-omlx', true);
    const result = await client.chatStream!(
      [{ role: 'user', content: 'go' }],
      TOOLS,
      () => {},
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe('read_file');
    expect(result.toolCalls![0]!.arguments).toEqual({ path: '/m.ts' });
    expect(result.content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Sanity: M118 re-exports still resolve through provider-client
// ---------------------------------------------------------------------------

describe('provider-client re-exports', () => {
  it('parseContentToolCalls + toolNamesFromSpecs still importable', () => {
    const names = toolNamesFromSpecs(TOOLS);
    expect(names.has('read_file')).toBe(true);
    const parsed = parseContentToolCalls(
      '{"name":"read_file","arguments":{"path":"/r"}}',
      names,
    );
    expect(parsed!.toolCalls[0]!.name).toBe('read_file');
  });
});
