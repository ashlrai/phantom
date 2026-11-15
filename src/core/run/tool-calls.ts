/**
 * tool-calls.ts — tool-call adapter/normalizer for chat provider clients.
 *
 * Hosted lanes (claude/codex CLI agents, the Anthropic Messages client) get
 * reliable function-calling from their harness. Local endpoints — Ollama's
 * /api/chat, OpenAI-compatible servers (LM Studio, llama-server, oMLX) —
 * return tool calls in several dialects, and models without native tool
 * support emit call markup as plain content instead. This module is the ONE
 * place that normalizes all of it into the canonical
 * `{ id, name, arguments }` shape `ChatResult.toolCalls` / `ChatMessage.toolCalls`
 * already use, so agent-loop.ts never learns a second format.
 *
 * RESPONSE side (provider → canonical):
 *   - parseOpenAIToolCalls   — OpenAI `tool_calls` (+ legacy `function_call`),
 *                              tolerant of flat entries and object arguments.
 *   - parseOllamaToolCalls   — Ollama `/api/chat` `message.tool_calls`.
 *   - parseContentToolCalls  — M118 bare-JSON fallback (fenced / whole /
 *                              balanced-brace candidates, allowlist-gated).
 *   - parseEmbeddedToolCalls — NEW: local-model markup dialects first
 *                              (`<tool_call>` frames carrying JSON, GLM or
 *                              Qwen3-Coder XML payloads; Mistral
 *                              `[TOOL_CALLS]…[ARGS]` sections), then the
 *                              M118 JSON fallback. This is what gives
 *                              tool-less MLX models (the shape oMLX serves
 *                              when its server-side parser misses — see
 *                              ml-explore/mlx-lm#984/#1335) the same loop.
 *   - normalizeAssistantMessage — structured-first compose: canonical calls
 *                              win; the embedded fallback fires only when the
 *                              endpoint returned no structured calls AND the
 *                              request actually advertised tools.
 *
 * REQUEST side (canonical → wire):
 *   - toOpenAIToolSpecs — projects internal specs (ExecutableToolSpec carries
 *                         `fn`/`safety`/top-level `name`; ToolSpec carries a
 *                         bare `name`) down to `{type:'function',function:{…}}`
 *                         so strict local servers never see internal fields.
 *   - serializeToolCallArgumentsForOpenAI / coerceToolCallArgumentsToObject —
 *                         replay-side argument encoding per dialect.
 *
 * Safety contract (unchanged from M118): embedded parsing only fires when
 * tools were advertised, and a call's `name` MUST be in the advertised set —
 * prose that merely looks like JSON is never executed.
 */

// ---------------------------------------------------------------------------
// Canonical shapes
// ---------------------------------------------------------------------------

/** Canonical tool call — the element type of ChatResult/ChatMessage toolCalls. */
export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** Result of an embedded (content-markup) parse: calls + markup-stripped text. */
export interface EmbeddedToolCalls {
  toolCalls: NormalizedToolCall[];
  /** Response content with the matched call markup removed. */
  cleanedContent: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Argument coercion
// ---------------------------------------------------------------------------

/**
 * Coerce a raw `arguments` payload: a JSON string is parsed (an unparseable
 * string is kept verbatim so the executor can report it), null/undefined
 * becomes {}, everything else passes through untouched.
 */
export function coerceToolCallArguments(raw: unknown): unknown {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Serialize `call.arguments` for an OpenAI-style replay, where `arguments` is
 * a STRING field containing JSON. Objects are stringified; a string is sent
 * verbatim (it is already the wire encoding — re-stringifying would double-quote
 * it); anything else degrades to '{}'.
 */
export function serializeToolCallArgumentsForOpenAI(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw ?? {});
  } catch {
    return '{}';
  }
}

/**
 * Coerce `call.arguments` to an object for dialects that carry structured
 * arguments (Ollama native `/api/chat`). Strings are JSON-parsed; an
 * unparseable string degrades to {} rather than poisoning the replay.
 */
export function coerceToolCallArgumentsToObject(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) || Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return raw ?? {};
}

// ---------------------------------------------------------------------------
// Structured response parsing
// ---------------------------------------------------------------------------

/**
 * Shared `tool_calls` array parser for OpenAI-compatible and Ollama-style
 * messages. Entries may nest the call under `function` (OpenAI) or carry
 * `name`/`arguments` flat (some local servers emit that); a string `id` is
 * preserved and a dense `call_<n>` id is synthesized otherwise. Entries with
 * no usable name are skipped — a nameless call cannot be routed anyway.
 */
function parseFunctionToolCalls(rawCalls: unknown): NormalizedToolCall[] | undefined {
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return undefined;
  const parsed: NormalizedToolCall[] = [];
  for (const tc of rawCalls) {
    if (!isRecord(tc)) continue;
    const fn = isRecord(tc['function']) ? tc['function'] : tc;
    const name = fn['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    const id =
      typeof tc['id'] === 'string' && tc['id'].length > 0
        ? tc['id']
        : `call_${parsed.length}`;
    parsed.push({ id, name, arguments: coerceToolCallArguments(fn['arguments']) });
  }
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * Parse tool calls from an OpenAI-compatible chat.completions message.
 * Handles `message.tool_calls` (nested `function` or flat entries, string or
 * object arguments) and the legacy single `message.function_call` shape.
 */
export function parseOpenAIToolCalls(
  message: Record<string, unknown>,
): NormalizedToolCall[] | undefined {
  const calls = parseFunctionToolCalls(message['tool_calls']);
  if (calls) return calls;
  const legacy = message['function_call'];
  if (isRecord(legacy)) {
    const name = legacy['name'];
    if (typeof name === 'string' && name.length > 0) {
      return [
        {
          id: 'call_legacy_0',
          name,
          arguments: coerceToolCallArguments(legacy['arguments']),
        },
      ];
    }
  }
  return undefined;
}

/**
 * Parse tool calls from an Ollama `/api/chat` response message
 * (`message.tool_calls` — `{function:{name, arguments}}`, no endpoint ids).
 */
export function parseOllamaToolCalls(
  message: Record<string, unknown>,
): NormalizedToolCall[] | undefined {
  return parseFunctionToolCalls(message['tool_calls']);
}

// ---------------------------------------------------------------------------
// Tool spec helpers (request + allowlist side)
// ---------------------------------------------------------------------------

/**
 * Build a Set of known tool names from an OpenAI-format or ToolSpec tools
 * array. Used by the embedded parsers to reject false positives.
 *   OpenAI format: [{type:'function', function:{name:'...'}}]
 *   ToolSpec format: [{name:'...'}]
 */
export function toolNamesFromSpecs(tools: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const t of tools) {
    if (!isRecord(t)) continue;
    const fn = t['function'];
    if (isRecord(fn) && typeof fn['name'] === 'string') {
      names.add(fn['name']);
      continue;
    }
    if (typeof t['name'] === 'string') names.add(t['name']);
  }
  return names;
}

/**
 * Project internal tool specs down to the OpenAI wire shape
 * `{type:'function', function:{…}}`.
 *
 * Internal specs (ExecutableToolSpec from mcp-native-engineer.ts) carry
 * `fn`, `safety` and a redundant top-level `name` alongside `type`/`function`;
 * JSON.stringify drops `fn` but NOT `name`/`safety`, and strict local servers
 * (pydantic-validated endpoints like oMLX) can reject unknown fields. Entries
 * already in `{type, function}` shape re-emit identically; bare ToolSpec-style
 * `{name, description, parameters|inputSchema}` entries are wrapped; anything
 * else passes through unchanged rather than being silently dropped.
 */
export function toOpenAIToolSpecs(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    if (!isRecord(t)) return t;
    const fn = t['function'];
    if (isRecord(fn)) {
      const type = typeof t['type'] === 'string' ? t['type'] : 'function';
      return { type, function: fn };
    }
    const name = t['name'];
    if (typeof name === 'string' && name.length > 0) {
      const parameters = t['parameters'] ?? t['inputSchema'];
      return {
        type: 'function',
        function: {
          name,
          ...(typeof t['description'] === 'string'
            ? { description: t['description'] }
            : {}),
          parameters: isRecord(parameters)
            ? parameters
            : { type: 'object', properties: {} },
        },
      };
    }
    return t;
  });
}

// ---------------------------------------------------------------------------
// Embedded (content-markup) parsing — M118 JSON shapes
// ---------------------------------------------------------------------------

/**
 * Convert a parsed JSON tool-call payload into canonical calls. Every item
 * must be an object whose `name` is in `toolNames` — prose JSON is never a
 * tool call. `arguments` (or `parameters`) may be an object or a JSON string.
 */
function callsFromJsonValue(
  value: unknown,
  toolNames: Set<string>,
): NormalizedToolCall[] | undefined {
  const items = Array.isArray(value) ? value : [value];
  const calls: NormalizedToolCall[] = [];
  for (const item of items) {
    if (!isRecord(item)) return undefined;
    const name = item['name'];
    if (typeof name !== 'string' || !toolNames.has(name)) return undefined;
    calls.push({
      id: `call_content_${calls.length}_${name.slice(0, 8)}`,
      name,
      arguments: coerceToolCallArguments(item['arguments'] ?? item['parameters']),
    });
  }
  return calls.length > 0 ? calls : undefined;
}

/**
 * First balanced {...} or [...] block in `text` at or after `from`,
 * string-aware so braces inside JSON string values don't end the scan early.
 * Returns the substring and its end offset, or undefined when unbalanced.
 */
function firstBalancedBlockFrom(
  text: string,
  from: number,
): { block: string; end: number } | undefined {
  const firstBracket = text.slice(from).search(/[{[]/);
  if (firstBracket === -1) return undefined;
  const start = from + firstBracket;
  const opener = text[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return { block: text.slice(start, i + 1), end: i };
    }
  }
  return undefined;
}

/**
 * Successive top-level balanced {...}/[...] blocks in `text` (bounded), so a
 * non-JSON bracket pair in prose (`[sic]`, `[1]`) doesn't hide a later call.
 */
function balancedBlocks(text: string, max = 8): string[] {
  const blocks: string[] = [];
  let pos = 0;
  while (blocks.length < max) {
    const found = firstBalancedBlockFrom(text, pos);
    if (!found) break;
    blocks.push(found.block);
    pos = found.end + 1;
  }
  return blocks;
}

/**
 * JSON candidates for embedded parsing, in priority order: fenced block,
 * whole trimmed text, then each balanced block in document order.
 */
function jsonCandidates(text: string): { json: string; fenced: boolean }[] {
  const candidates: { json: string; fenced: boolean }[] = [];
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) candidates.push({ json: fenceMatch[1].trim(), fenced: true });
  candidates.push({ json: text, fenced: false });
  for (const block of balancedBlocks(text)) {
    if (!candidates.some((c) => c.json === block)) {
      candidates.push({ json: block, fenced: false });
    }
  }
  return candidates;
}

/**
 * M118 content-embedded fallback — bare JSON tool calls in message content.
 * Accepted shapes: {"name","arguments"|"parameters"} object or array, JSON
 * string or object arguments, ``` fenced blocks, and JSON embedded in prose.
 * Fires only when `toolNames` is non-empty and every candidate item names a
 * known tool. Returns the calls plus content with the matched JSON removed.
 */
export function parseContentToolCalls(
  content: string,
  toolNames: Set<string>,
): EmbeddedToolCalls | undefined {
  if (!content || toolNames.size === 0) return undefined;

  const text = content.trim();

  for (const { json: candidate, fenced } of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    const calls = callsFromJsonValue(parsed, toolNames);
    if (!calls) continue;

    // Strip the matched JSON so it doesn't surface as final text.
    let cleanedContent: string;
    if (fenced) {
      cleanedContent = text.replace(/```(?:json)?\s*\n?[\s\S]*?\n?```/, '').trim();
    } else {
      cleanedContent = text.replace(candidate, '').trim();
    }
    return { toolCalls: calls, cleanedContent };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Embedded (content-markup) parsing — local-model dialects
// ---------------------------------------------------------------------------
//
// MLX-served models (what oMLX fronts) emit tool calls in the chat template's
// native markup when the server-side parser misses — multi-token delimiters,
// merged `>` tokens, or a template with no tools support at all. The dialects
// below are the ones mlx-lm's tool_parsers cover that carry enough structure
// to parse safely against the advertised-name allowlist:
//
//   json_tools / qwen35 : <tool_call>{"name":"f","arguments":{…}}</tool_call>
//   qwen3_coder (XML)   : <tool_call><function=f><parameter=k>v</parameter>…</function></tool_call>
//   glm4 (framed)       : <tool_call>f<arg_key>k</arg_key><arg_value>v</arg_value>…</tool_call>
//   mistral             : [TOOL_CALLS]f [ARGS]{…}
//
// Deliberately NOT parsed (rarer dialects; noted for a later slice): lfm2,
// gemma/gemma4, kimi-k2, minimax-m2, atem, llama3 <|python_tag|>, gpt-oss
// harmony, and GLM's markerless `name\n{…}` (too ambiguous without schema).

/** `<tool_call …>…</tool_call>` frame, inner payload captured. */
const TOOL_CALL_FRAME_RE = /<tool_call(?:\s[^>]*)?>([\s\S]*?)<\/tool_call\s*>/g;
/** `<function=name>…<parameter=k>v</parameter>…</function>` (qwen3_coder XML). */
const XML_FUNCTION_RE = /<function=([^<>\s]+)>([\s\S]*?)<\/function\s*>/g;
const XML_PARAMETER_RE = /<parameter=([^<>\s]+)>([\s\S]*?)<\/parameter>/g;
/** GLM `<arg_key>k</arg_key><arg_value>v</arg_value>` pairs. */
const GLM_ARG_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
/** Mistral `[TOOL_CALLS]name [ARGS]{…}` sections. */
const MISTRAL_SECTION_RE = /\[TOOL_CALLS\]\s*([A-Za-z0-9_-]+)\s*\[ARGS\]\s*(\{[\s\S]*?\})\s*(?=\[TOOL_CALLS\]|$)/g;

/** Scalar coercion for XML/GLM parameter values: JSON when possible, else text. */
function coerceParamValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Python-style single-quoted literal ('fiction', 'it''s') — strip one layer.
    if (trimmed.length > 1 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }
}

/**
 * Parse the inside of a `<tool_call>` frame. Dispatch order: Qwen3-Coder XML
 * (`<function=`), GLM (`<arg_key>`), then the JSON candidates (bare/fenced/
 * balanced) used by json_tools and Qwen3.5. Returns undefined when nothing
 * inside names an advertised tool.
 */
function callsFromToolCallFrame(
  inner: string,
  toolNames: Set<string>,
): NormalizedToolCall[] | undefined {
  const text = inner.trim();
  if (text === '') return undefined;

  if (text.includes('<function=')) {
    const calls: NormalizedToolCall[] = [];
    for (const fnMatch of text.matchAll(XML_FUNCTION_RE)) {
      const name = fnMatch[1]!.trim();
      if (!toolNames.has(name)) continue;
      const args: Record<string, unknown> = {};
      for (const pMatch of fnMatch[2]!.matchAll(XML_PARAMETER_RE)) {
        args[pMatch[1]!.trim()] = coerceParamValue(pMatch[2]!);
      }
      calls.push({
        id: `call_xml_${calls.length}_${name.slice(0, 8)}`,
        name,
        arguments: args,
      });
    }
    if (calls.length > 0) return calls;
  }

  if (text.includes('<arg_key>')) {
    // GLM framed: `name<arg_key>k</arg_key><arg_value>v</arg_value>…`
    const keyAt = text.indexOf('<arg_key>');
    const name = text.slice(0, keyAt).trim();
    if (toolNames.has(name)) {
      const args: Record<string, unknown> = {};
      for (const m of text.matchAll(GLM_ARG_RE)) {
        args[m[1]!.trim()] = coerceParamValue(m[2]!);
      }
      return [{ id: `call_glm_0_${name.slice(0, 8)}`, name, arguments: args }];
    }
    return undefined;
  }

  // JSON payload (json_tools / qwen35): reuse the M118 candidate pipeline on
  // the frame's inner text only.
  for (const { json: candidate } of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const calls = callsFromJsonValue(parsed, toolNames);
    if (calls) {
      // Re-id under the tag prefix so provenance stays visible in steps.
      return calls.map((c, i) => ({ ...c, id: `call_tag_${i}_${c.name.slice(0, 8)}` }));
    }
  }
  return undefined;
}

/**
 * Embedded tool-call parse for local-model markup dialects. Scans for
 * `<tool_call>` frames and Mistral `[TOOL_CALLS]` sections; every candidate
 * name must be advertised. Returns calls plus content with the matched spans
 * removed. Returns undefined when no markup parses — the caller then falls
 * back to the bare-JSON M118 path.
 */
export function parseTaggedToolCalls(
  content: string,
  toolNames: Set<string>,
): EmbeddedToolCalls | undefined {
  if (!content || toolNames.size === 0) return undefined;
  const text = content;
  // Collect (position → calls, span) from both dialects, then emit in
  // document order so parallel calls execute in the order the model wrote them.
  const found: Array<{ index: number; calls: NormalizedToolCall[]; span: [number, number] }> = [];

  for (const m of text.matchAll(TOOL_CALL_FRAME_RE)) {
    const frameCalls = callsFromToolCallFrame(m[1]!, toolNames);
    if (!frameCalls || frameCalls.length === 0) continue;
    found.push({
      index: m.index!,
      calls: frameCalls,
      span: [m.index!, m.index! + m[0].length],
    });
  }

  for (const m of text.matchAll(MISTRAL_SECTION_RE)) {
    const name = m[1]!;
    if (!toolNames.has(name)) continue;
    let args: unknown;
    try {
      args = JSON.parse(m[2]!) as unknown;
    } catch {
      continue;
    }
    found.push({
      index: m.index!,
      calls: [{ id: `call_mistral_${found.length}_${name.slice(0, 8)}`, name, arguments: args }],
      span: [m.index!, m.index! + m[0].length],
    });
  }

  if (found.length === 0) return undefined;
  found.sort((a, b) => a.index - b.index);
  const calls = found.flatMap((f) => f.calls);
  const spans = found.map((f) => f.span);

  // Strip matched spans back-to-front so earlier offsets stay valid.
  spans.sort((a, b) => b[0] - a[0]);
  let cleaned = text;
  for (const [start, end] of spans) {
    cleaned = cleaned.slice(0, start) + cleaned.slice(end);
  }
  return { toolCalls: calls, cleanedContent: cleaned.trim() };
}

/**
 * Full embedded fallback: local-model markup dialects first (strongest
 * signal), then the M118 bare-JSON shapes. This is the parse half of the
 * adapter — it runs only when the endpoint returned no structured tool_calls.
 */
export function parseEmbeddedToolCalls(
  content: string,
  toolNames: Set<string>,
): EmbeddedToolCalls | undefined {
  return parseTaggedToolCalls(content, toolNames) ?? parseContentToolCalls(content, toolNames);
}

// ---------------------------------------------------------------------------
// Response normalizer (structured-first compose)
// ---------------------------------------------------------------------------

/**
 * Normalize one assistant response into `{content, toolCalls?}`.
 *
 * Structured calls (already parsed by the dialect-specific parser) always win.
 * The embedded fallback fires ONLY when there were no structured calls, the
 * request advertised tools (`advertisedTools` non-empty — pass the tools that
 * were actually sent on the wire, not merely supplied to chat()), and the
 * content is non-empty. When the fallback fires, `content` is the markup-
 * stripped text so raw JSON/tags never surface as the final answer.
 */
export function normalizeAssistantMessage(input: {
  content: string;
  toolCalls?: NormalizedToolCall[];
  advertisedTools?: unknown[];
}): { content: string; toolCalls?: NormalizedToolCall[] } {
  const { content, toolCalls, advertisedTools } = input;
  if (toolCalls && toolCalls.length > 0) return { content, toolCalls };
  if (advertisedTools && advertisedTools.length > 0 && content) {
    const embedded = parseEmbeddedToolCalls(content, toolNamesFromSpecs(advertisedTools));
    if (embedded) return { content: embedded.cleanedContent, toolCalls: embedded.toolCalls };
  }
  return { content };
}

/** Normalize a whole OpenAI-compatible `choices[0].message` payload. */
export function normalizeChatCompletionMessage(
  message: Record<string, unknown>,
  advertisedTools?: unknown[],
): { content: string; toolCalls?: NormalizedToolCall[] } {
  const content = typeof message['content'] === 'string' ? message['content'] : '';
  return normalizeAssistantMessage({
    content,
    toolCalls: parseOpenAIToolCalls(message),
    advertisedTools,
  });
}

/** Normalize an Ollama `/api/chat` `message` payload. */
export function normalizeOllamaMessage(
  message: Record<string, unknown>,
  advertisedTools?: unknown[],
): { content: string; toolCalls?: NormalizedToolCall[] } {
  const content = typeof message['content'] === 'string' ? message['content'] : '';
  return normalizeAssistantMessage({
    content,
    toolCalls: parseOllamaToolCalls(message),
    advertisedTools,
  });
}

// ---------------------------------------------------------------------------
// Streaming fragment normalization (OpenAI SSE tool_calls deltas)
// ---------------------------------------------------------------------------

/** One accumulated `tool_calls` delta fragment (arguments still a string). */
export interface ToolCallFragment {
  id: string;
  name: string;
  argsStr: string;
}

/**
 * Finalize accumulated stream fragments into canonical calls. Fragment ids
 * may arrive empty (some local servers omit them); argsStr is parsed as JSON
 * with unparseable text kept verbatim — the same contract as the
 * non-streaming path. Returns undefined when nothing accumulated.
 */
export function normalizeStreamedToolCallFragments(
  fragments: Iterable<ToolCallFragment>,
): NormalizedToolCall[] | undefined {
  const parsed: NormalizedToolCall[] = [];
  let index = 0;
  for (const frag of fragments) {
    if (!frag.name) continue;
    parsed.push({
      id: frag.id || `call_stream_${index}`,
      name: frag.name,
      arguments: frag.argsStr ? coerceToolCallArguments(frag.argsStr) : {},
    });
    index++;
  }
  return parsed.length > 0 ? parsed : undefined;
}
