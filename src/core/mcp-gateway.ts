/**
 * core/mcp-gateway.ts — MCP aggregation gateway + per-server probe.
 *
 * Two responsibilities:
 *
 *   1. probeServer(spec, timeoutMs): start ONE downstream MCP server as a child,
 *      list its tools, tear it down, and return an McpServerHealth. NEVER throws —
 *      startup failures, timeouts, and crashes surface in the returned health
 *      object (ok:false + error). Used by `ashlr mcp doctor` and gateway startup.
 *
 *   2. startGateway(registry): run a stdio MCP server (this process) that starts
 *      every discovered downstream as a child, namespaces their tools as
 *      `<server>__<tool>`, and proxies tools/list + tools/call to the correct
 *      downstream. ROBUST: per-downstream startup timeout; a downstream that
 *      fails to start is skipped with a stderr warning and never crashes the
 *      gateway. Point ANY agent at `ashlr mcp` to get every discovered tool.
 *
 * This module is the ONLY place (besides mcp-registry) allowed to depend on
 * @modelcontextprotocol/sdk.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ChildProcess } from 'node:child_process';
import { Writable } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import type { McpRegistry, McpServerSpec, McpServerHealth, HealEvent } from './types.js';
import { loadConfig } from './config.js';
import { withToolEnv } from './env-bridge.js';
import { withHeal, defaultHealPolicy } from './run/self-heal.js';
import { listNativeTools, isNativeTool, callNativeTool } from './mcp-native.js';
import { listFirmResources, listFirmResourceTemplates, readFirmResource } from './mcp-firm-resources.js';
import { hasSecretLikeArgv, redactedCommand } from './mcp-argv-safety.js';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubSecrets } from './util/scrub.js';
import { getLocusJobEnv, hasInheritedLocusSession, hasLocusJobEnv, withLocusJobChildEnv } from './integrations/locus-job-env.js';
import { spawnSessionChild } from './verse/process-registry.js';

/** SDK-compatible stdio with session-owned process groups and parent-death cleanup. */
export class SessionStdioClientTransport extends StdioClientTransport {
  private sessionProcess: ChildProcess | null = null;
  private readonly sessionBuffer: ReadBuffer;
  private closing: Promise<void> | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly sessionParams: StdioServerParameters, private readonly owningSessionId = 'mcp') {
    super(sessionParams);
    this.sessionBuffer = new ReadBuffer({ maxBufferSize: sessionParams.maxBufferSize });
  }

  override get pid(): number | null { return this.sessionProcess?.pid ?? null; }

  override async start(): Promise<void> {
    if (this.started || this.closed) throw new Error('SessionStdioClientTransport already started or closed');
    this.started = true;
    const child = spawnSessionChild(this.sessionParams.command, this.sessionParams.args ?? [], {
      env: { ...getDefaultEnvironment(), ...this.sessionParams.env },
      cwd: this.sessionParams.cwd,
      stdio: ['pipe', 'pipe', this.sessionParams.stderr ?? 'inherit'],
      shell: false,
      windowsHide: process.platform === 'win32',
    }, this.owningSessionId);
    this.sessionProcess = child;
    const stderr = super.stderr;
    if (stderr instanceof Writable && child.stderr) child.stderr.pipe(stderr);
    child.once('close', () => {
      this.sessionProcess = null;
      this.sessionBuffer.clear();
      this.onclose?.();
    });
    child.stdin?.on('error', (error: Error) => this.onerror?.(error));
    child.stdout?.on('error', (error: Error) => this.onerror?.(error));
    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        this.sessionBuffer.append(chunk);
        for (;;) {
          const message = this.sessionBuffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        }
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        void this.close();
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.on('error', (error: Error) => { reject(error); this.onerror?.(error); });
    });
  }

  override async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.sessionProcess?.stdin;
    if (!stdin || this.closing) throw new Error('Not connected');
    await new Promise<void>((resolve, reject) => {
      stdin.write(serializeMessage(message), (error) => error ? reject(error) : resolve());
    });
  }

  override close(): Promise<void> {
    this.closed = true;
    this.closing ??= this.closeSession();
    return this.closing;
  }

  private async closeSession(): Promise<void> {
    const child = this.sessionProcess;
    if (!child) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>((resolve) => child.once('close', resolve));
    child.stdin?.end();
    // Only Phantom holds the other end of this descriptor. Closing it asks the
    // watchdog to reap the entire owned group, including stubborn descendants.
    child.stdio[3]?.destroy();
    try {
      await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    this.sessionBuffer.clear();
  }
}

/**
 * Phantom's package version for MCP serverInfo/clientInfo, so clients and
 * agents see the real release instead of a placeholder. Same lookup as
 * `phm --version` (ASHLR_VERSION covers the Bun SEA build).
 */
let cachedGatewayVersion: string | undefined;
export function gatewayVersion(): string {
  if (cachedGatewayVersion) return cachedGatewayVersion;
  let version = process.env.ASHLR_VERSION;
  if (!version) {
    try {
      version = (createRequire(import.meta.url)('../../package.json') as { version?: string }).version;
    } catch { /* fall through */ }
  }
  cachedGatewayVersion = typeof version === 'string' && version.trim() ? version.trim() : '0.0.0-unknown';
  return cachedGatewayVersion;
}

// ---------------------------------------------------------------------------
// M105: Browser MCP probe + tool-call helpers
// ---------------------------------------------------------------------------

/**
 * Server name keywords that identify a Claude-in-Chrome / browser MCP server.
 * Matching is case-insensitive substring check against the spec.name.
 */
const BROWSER_SERVER_KEYWORDS = ['claude-in-chrome', 'chrome', 'browser'] as const;

/**
 * Tools that a compatible browser MCP server must expose (at least one must
 * be present for us to consider it reachable and usable).
 */
const BROWSER_REQUIRED_TOOLS = ['navigate', 'read_page', 'computer'] as const;

/**
 * Result of a browser-MCP reachability probe.
 * Exposed so apply.ts can call the gateway without importing the SDK.
 */
export interface BrowserProbeResult {
  reachable: boolean;
  serverName: string | null;
  /** Tools actually found on the server (subset we care about). */
  availableTools: string[];
  error?: string;
}

/**
 * Probe the configured MCP registry for a reachable Claude-in-Chrome (or
 * compatible) browser automation server.
 *
 * NEVER throws. Returns { reachable:false } on any failure so apply.ts can
 * degrade gracefully without crashing.
 *
 * @param registry   The discovered MCP servers to search.
 * @param timeoutMs  Per-probe startup/list timeout (default 8s).
 */
export async function probeBrowserMcp(
  registry: McpRegistry,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BrowserProbeResult> {
  // Find candidate specs by keyword matching on spec.name (case-insensitive).
  const candidates = registry.servers.filter((spec) => {
    const lower = spec.name.toLowerCase();
    return BROWSER_SERVER_KEYWORDS.some((kw) => lower.includes(kw));
  });

  if (candidates.length === 0) {
    return {
      reachable: false,
      serverName: null,
      availableTools: [],
      error: 'no browser MCP server configured (no spec name matches claude-in-chrome / chrome / browser)',
    };
  }

  // Try each candidate in order; first reachable one wins.
  for (const spec of candidates) {
    const health = await probeServer(spec, timeoutMs);
    if (!health.ok) continue;

    // Check that at least one required browser tool is present.
    const found = BROWSER_REQUIRED_TOOLS.filter((t) => health.tools.includes(t));
    if (found.length === 0) continue;

    return {
      reachable: true,
      serverName: spec.name,
      availableTools: health.tools,
    };
  }

  return {
    reachable: false,
    serverName: null,
    availableTools: [],
    error: `browser MCP server(s) found (${candidates.map((s) => s.name).join(', ')}) but none reachable or missing required tools`,
  };
}

/**
 * Call a tool on a browser MCP server (already known-reachable via
 * probeBrowserMcp). Opens a fresh connection, calls the tool, closes it.
 *
 * NEVER throws — any failure is returned as { ok:false, detail }.
 * The caller (apply.ts) is responsible for auditing the result.
 *
 * @param spec      The server spec to connect to.
 * @param toolName  The tool to call (e.g. 'navigate', 'read_page').
 * @param args      Arguments to pass to the tool.
 * @param timeoutMs Per-call timeout (default 8s).
 */
export async function callBrowserTool(
  spec: McpServerSpec,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; detail: string; result?: unknown }> {
  let client: Client | null = null;
  let cfgForCall: ReturnType<typeof loadConfig> | undefined;
  try { cfgForCall = loadConfig(); } catch { /* non-fatal */ }
  try {
    client = await connectDownstream(spec, timeoutMs, cfgForCall);
    const result = await withDeadline(
      client.callTool({ name: toolName, arguments: args }, undefined, { timeout: timeoutMs }),
      timeoutMs, `callTool(${spec.name}/${toolName})`,
    );
    return { ok: true, detail: `${spec.name}/${toolName} succeeded`, result };
  } catch (err) {
    const msg = safeErrorMessage(err);
    return { ok: false, detail: `${spec.name}/${toolName} failed: ${msg}` };
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Look up a browser MCP server spec by name in the registry.
 * Returns null when not found.
 */
export function findBrowserSpec(registry: McpRegistry, serverName: string): McpServerSpec | null {
  return registry.servers.find((s) => s.name === serverName) ?? null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-downstream startup/list timeout. */
const DEFAULT_TIMEOUT_MS = 8_000;

/** Namespacing separator: gateway tool name = `<server>__<tool>`. */
const NS = '__';

// A discovery is one bounded snapshot, not an unbounded series of page requests.
const MAX_DISCOVERY_PAGES = 64;
const MAX_DISCOVERY_TOOLS = 4_096;
const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;
const MAX_CURSOR_BYTES = 4_096;

/**
 * A tools/call for a name the gateway does not route is the caller's mistake,
 * so it answers JSON-RPC -32602 (invalid params), not the SDK's default -32603
 * (internal error). The message text is kept as is: the SDK sends `message` and
 * `code` from the thrown error. Downstream failures (McpError, or any error
 * without the `Unknown tool "` prefix) pass through unchanged.
 */
export function unknownToolAsInvalidParams<A extends unknown[], R>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof Error && !(err instanceof McpError) && err.message.startsWith('Unknown tool "')) {
        throw Object.assign(err, { code: ErrorCode.InvalidParams });
      }
      throw err;
    }
  };
}

/**
 * Env var set on every downstream child the gateway spawns. A downstream that
 * is itself an ashlr gateway can read this to refuse re-aggregation, providing
 * a second line of defense against the self-spawn fork bomb (the primary
 * defense is isSelfGateway() filtering at startGateway).
 */
export const GATEWAY_ENV_MARKER = 'ASHLR_MCP_GATEWAY';

/**
 * The error text for a tools/call the gateway cannot route. Downstream tools
 * are served as `<server>__<tool>`, but their own docs (and the agent) use the
 * bare name, so a bare or differently spelled name names the routed tool(s)
 * it most likely meant. Suggestions only; nothing is called on a guess.
 */
export function unknownToolMessage(requested: string, routed: Iterable<{ name: string; original: string }>): string {
  const norm = (value: string): string => value.toLowerCase().replace(/-/g, '_');
  const wanted = norm(requested);
  const matches: string[] = [];
  for (const { name, original } of routed) {
    if (matches.length >= 3) break;
    if (norm(original) === wanted || norm(name) === wanted) matches.push(name);
  }
  const hint = matches.length === 1
    ? ` Did you mean "${matches[0]}"? Gateway tools from other servers are named <server>${NS}<tool>.`
    : matches.length > 1
      ? ` Did you mean one of ${matches.map((m) => `"${m}"`).join(', ')}? Gateway tools from other servers are named <server>${NS}<tool>.`
      : '';
  return `Unknown tool "${requested}".${hint} Run \`ashlr mcp list\` to see available tools.`;
}

// The MCP SDK deliberately spawns downstream servers with a NARROW env allowlist
// (not the full process.env) so ambient secrets don't leak into third-party servers.
// We preserve that isolation: downstreams get this safe base + ashlr's non-secret
// config keys (via withToolEnv) + their own declared spec.env — never the hub's full env.
const SAFE_CHILD_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'ASHLR_HOME',
  'PATH',
  'SHELL',
  'TERM',
  'USER',
  'LOGNAME',
] as const;
function safeChildBase(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const k of SAFE_CHILD_ENV_KEYS) {
    if (getLocusJobEnv()[k] !== undefined) base[k] = getLocusJobEnv()[k];
  }
  return base;
}

/**
 * True when a spec resolves to THIS aggregation gateway — i.e. running it as a
 * downstream would recurse (`ashlr mcp install` writes exactly such an entry:
 * name "ashlr", command <bin>/ashlr, args ['mcp']). Recognize installed aliases
 * and Node wrappers without resolving user-controlled executable paths. The
 * legacy `phantom` name and executable belong to Phantom Secrets, so neither
 * alone identifies this gateway. Inherited markers cover opaque wrappers.
 */
export function isSelfGateway(spec: McpServerSpec): boolean {
  const mcpIndex = spec.args.indexOf('mcp');
  if (mcpIndex < 0) return false;
  const executableName = (value: string): string =>
    (value.split(/[\\/]/).pop() ?? value).replace(/\.(?:cmd|exe)$/i, '').toLowerCase();
  const gatewayNames = new Set(['ashlr', 'phm']);
  if (gatewayNames.has(spec.name.toLowerCase())) return true;
  const command = executableName(spec.command);
  if (command === 'ashlr' || command === 'phm') return true;
  // `node /path/bin/phm mcp` must be excluded just like `phm mcp`.
  return (command === 'node' || command === 'bun' || command === 'tsx')
    && spec.args.slice(0, mcpIndex).some((arg) => {
      const name = executableName(arg);
      return name === 'ashlr' || name === 'phm'
        || resolve(arg) === fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url))
        || resolve(arg) === fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Bound an operation and clear its deadline on either settlement path. */
async function withDeadline<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function downstreamEnv(spec: McpServerSpec, cfg?: ReturnType<typeof loadConfig>): Record<string, string> {
  // Validate AFTER the per-server override. A declared HOME/LOCUS scope must
  // never replace a delegated job's captured identity at the final spawn.
  const merged = withLocusJobChildEnv({
    ...(cfg ? withToolEnv(cfg, safeChildBase()) : safeChildBase()),
    ...(spec.env ?? {}),
    [GATEWAY_ENV_MARKER]: '1',
  });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function refuseSharedJobGateway(): void {
  if (hasLocusJobEnv() || hasInheritedLocusSession()) throw new Error('Shared MCP gateway unavailable inside a delegated Locus job');
}

function safeErrorMessage(err: unknown): string {
  return scrubSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * Build a connected SDK Client for one downstream spec, racing the connect
 * against a timeout. The caller owns closing the returned client.
 * Throws on failure (caller wraps).
 */
async function connectDownstream(spec: McpServerSpec, timeoutMs: number, cfg?: ReturnType<typeof loadConfig>, capturedEnv?: Record<string, string>): Promise<Client> {
  // Probes do not pass through startGateway's registry filter.
  if (isSelfGateway(spec)) throw new Error('MCP gateway self-spawn refused: would recurse');
  if (hasSecretLikeArgv(spec.args)) {
    throw new Error(
      `unsafe MCP argv refused for "${spec.name}": ${redactedCommand(spec.command, spec.args)} ` +
      '(move credentials to env, Phantom, or a wrapper/config file)',
    );
  }
  const transport = new SessionStdioClientTransport({
    command: spec.command,
    args: spec.args,
    // Persistent recovery reuses the exact captured startup environment. One-off
    // job probes validate the final configured override against their snapshot.
    env: { ...(capturedEnv ?? downstreamEnv(spec, cfg)), [GATEWAY_ENV_MARKER]: '1' },
    // Surface child stderr to our stderr for debugging; never pollutes stdio JSON-RPC.
    stderr: 'inherit',
  }, `mcp:${spec.name}`);

  const client = new Client(
    { name: 'ashlr-gateway', version: gatewayVersion() },
    { capabilities: {} },
  );

  try {
    const connectPromise = client.connect(transport);
    let cancelled = false;
    // A late connect must not leave an unowned child after its deadline won.
    void connectPromise.then(() => {
      if (cancelled) {
        void client.close().catch(() => {});
        void transport.close().catch(() => {});
      }
    }, () => {});
    try {
      await withDeadline(connectPromise, timeoutMs, `connect(${spec.name})`);
    } catch (err) {
      cancelled = true;
      throw err;
    }
  } catch (err) {
    // SDK transport teardown reaps its child; bound awaiting a broken peer.
    try { await withDeadline(client.close(), timeoutMs, `close(${spec.name})`); } catch { /* ignore */ }
    try { await withDeadline(transport.close(), timeoutMs, `transport-close(${spec.name})`); } catch { /* ignore */ }
    throw err;
  }

  return client;
}

/** Read every page before replacing an inventory; reject incomplete/ambiguous snapshots. */
async function discoverTools(client: Client, serverName: string, timeoutMs: number): Promise<DownstreamTool[]> {
  const deadline = performance.now() + timeoutMs;
  const tools: DownstreamTool[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new Error(`tools/list(${serverName}) discovery timed out after ${timeoutMs}ms`);
    const listed = await withDeadline(
      client.listTools(cursor === undefined ? {} : { cursor }, { timeout: remaining }),
      remaining, `tools/list(${serverName})`,
    );
    if (!listed || !Array.isArray(listed.tools)) throw new Error('Invalid downstream tools inventory');
    // The SDK has already parsed the response. This bounds the inventory we
    // retain/publish, including schemas and descriptions, across all pages.
    if (tools.length + listed.tools.length > MAX_DISCOVERY_TOOLS) throw new Error('Downstream tools inventory exceeds tool limit');
    bytes += Buffer.byteLength(JSON.stringify(listed), 'utf8');
    if (bytes > MAX_DISCOVERY_BYTES) throw new Error('Downstream tools inventory exceeds byte limit');
    for (const tool of listed.tools) {
      if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) throw new Error('Invalid downstream tool name');
      if (names.has(tool.name)) throw new Error('Duplicate downstream tool name');
      names.add(tool.name);
      tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    }
    if (performance.now() >= deadline) throw new Error(`tools/list(${serverName}) discovery timed out after ${timeoutMs}ms`);
    if (listed.nextCursor === undefined) return tools;
    if (typeof listed.nextCursor !== 'string' || !listed.nextCursor || Buffer.byteLength(listed.nextCursor, 'utf8') > MAX_CURSOR_BYTES) {
      throw new Error('Invalid downstream tools cursor');
    }
    if (cursors.has(listed.nextCursor)) throw new Error('Downstream tools cursor cycle');
    cursors.add(listed.nextCursor);
    cursor = listed.nextCursor;
  }
  throw new Error('Downstream tools discovery exceeds page limit');
}

// ---------------------------------------------------------------------------
// probeServer
// ---------------------------------------------------------------------------

/**
 * Start a single downstream MCP server, list its tools, and tear it down.
 * NEVER throws — all failures (ENOENT, crash, timeout) are reported via the
 * returned McpServerHealth (ok:false, toolCount:0, tools:[], error:<msg>).
 *
 * @param spec       The downstream server spec to probe.
 * @param timeoutMs  Per-probe startup/list timeout (default 8s).
 */
export async function probeServer(
  spec: McpServerSpec,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<McpServerHealth> {
  // M10: load config once so probeServer also bridges env into probed children.
  // loadConfig() is lightweight (fs read + merge); safe to call per-probe.
  let cfgForProbe: ReturnType<typeof loadConfig> | undefined;
  try { cfgForProbe = loadConfig(); } catch { /* non-fatal: fall back to process.env */ }
  let client: Client | null = null;
  try {
    client = await connectDownstream(spec, timeoutMs, cfgForProbe);

    const tools = (await discoverTools(client, spec.name, timeoutMs)).map((tool) => tool.name);
    return {
      name: spec.name,
      ok: true,
      toolCount: tools.length,
      tools,
    };
  } catch (err) {
    const msg = safeErrorMessage(err);
    return {
      name: spec.name,
      ok: false,
      toolCount: 0,
      tools: [],
      error: msg,
    };
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// startGateway
// ---------------------------------------------------------------------------

interface DownstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Keep failed configured servers too; discovery may recover them later. */
interface Downstream {
  spec: McpServerSpec;
  env: Record<string, string>;
  client: Client | null;
  tools: DownstreamTool[];
  hasInventory: boolean;
  discoveryError?: string;
  generation: number;
  failures: number;
  retryAfter: number;
  inFlight?: Promise<void>;
}

/**
 * Persistent stdio aggregation. Read-only tools/list may reconnect a failed
 * configured server once after bounded backoff; effectful calls are never
 * retried. Recovery preserves the captured command, args and child environment.
 * Inventories are replaced only after bounded, complete pagination. Failed
 * refreshes retain the last inventory for collision reservation and diagnosis,
 * revoke its routes, and report stale/unavailable state in tools/list _meta.
 * Ambiguous namespace keys are omitted from both inventory and dispatch.
 * The serialized-byte limit applies after SDK parsing, not transport allocation.
 */
export async function startGateway(
  registry: McpRegistry,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const startupParent = process.ppid;
  // This also catches aliases and opaque executable wrappers that structural
  // registry filtering cannot recognize. Check before any downstream starts.
  if (process.env[GATEWAY_ENV_MARKER] !== undefined) {
    throw new Error('Nested MCP gateway refused: inherited gateway marker would recurse');
  }
  refuseSharedJobGateway();
  let gatewayCfg: ReturnType<typeof loadConfig> | undefined;
  try { gatewayCfg = loadConfig(); } catch { /* non-fatal; retain narrow child env */ }

  const downstreams: Downstream[] = registry.servers.filter((spec) => {
    if (!isSelfGateway(spec)) return true;
    process.stderr.write(`[ashlr mcp] skipping self "${spec.name}" (${redactedCommand(spec.command, spec.args)}) — would recurse\n`);
    return false;
  }).map((original) => {
    const spec = { ...original, args: [...original.args], env: original.env ? { ...original.env } : undefined };
    Object.freeze(spec.args);
    if (spec.env) Object.freeze(spec.env);
    Object.freeze(spec);
    return { spec, env: downstreamEnv(spec, gatewayCfg), client: null, tools: [], hasInventory: false, generation: 0, failures: 0, retryAfter: 0 };
  });
  interface Route { downstream: Downstream; client: Client; original: string }
  const routes = new Map<string, Route>();
  const rejectedRoutes = new Set<string>();
  let closed = false;
  const noHeal = process.env['ASHLR_NO_HEAL'] === '1';

  const rebuildRoutes = (): void => {
    routes.clear();
    rejectedRoutes.clear();
    if (closed) return;
    const owners = new Map<string, Downstream>();
    // Retained stale inventories reserve their names too: a failed peer must
    // not silently redirect its previously advertised name to a different peer.
    for (const d of downstreams) for (const tool of d.tools) {
      const key = `${d.spec.name}${NS}${tool.name}`;
      if (isNativeTool(key) || owners.has(key)) rejectedRoutes.add(key);
      else owners.set(key, d);
    }
    for (const d of downstreams) {
      if (!d.client || d.discoveryError !== undefined || !d.hasInventory) continue;
      for (const tool of d.tools) {
        const key = `${d.spec.name}${NS}${tool.name}`;
        if (rejectedRoutes.has(key)) continue;
        routes.set(key, { downstream: d, client: d.client, original: tool.name });
      }
    }
  };
  const closeClient = async (client: Client): Promise<void> => {
    try { await withDeadline(client.close(), timeoutMs, 'downstream close'); } catch { /* best effort; no retry */ }
  };
  const drop = async (d: Downstream, client: Client | null): Promise<void> => {
    if (client && d.client !== client) return; // an old peer cannot revoke its replacement
    d.generation++;
    d.client = null;
    d.discoveryError ??= 'Downstream connection closed';
    d.failures++;
    d.retryAfter = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(d.failures - 1, 6));
    rebuildRoutes(); // revoke before awaiting cleanup
    if (client) await closeClient(client);
  };

  const refresh = (d: Downstream, startup = false): Promise<void> => {
    if (closed) return Promise.resolve();
    if (d.inFlight) return d.inFlight;
    if (!d.client && Date.now() < d.retryAfter) return Promise.resolve();
    const generation = d.generation;
    const operation = (async (): Promise<void> => {
      let client = d.client;
      try {
        if (!client) {
          const connect = (): Promise<Client> => connectDownstream(d.spec, timeoutMs, undefined, d.env);
          client = startup && !noHeal
            ? await withHeal(connect, defaultHealPolicy(), (event: HealEvent) => {
              process.stderr.write(`[ashlr mcp] heal(${event.kind}) "${d.spec.name}" attempt ${event.attempt}: ${safeErrorMessage(event.detail)}\n`);
            })
            : await connect();
          if (closed || generation !== d.generation) { await closeClient(client); return; }
          d.client = client;
          const connected = client;
          client.onclose = () => { if (!closed && d.client === connected) void drop(d, connected); };
        }
        const tools = await discoverTools(client, d.spec.name, timeoutMs);
        if (closed || generation !== d.generation || d.client !== client) return;
        d.tools = tools;
        d.hasInventory = true;
        d.discoveryError = undefined;
        d.failures = 0;
        d.retryAfter = 0;
        rebuildRoutes(); // replace the complete inventory, including deleted tools
      } catch (err) {
        if (closed || generation !== d.generation) return;
        d.discoveryError = safeErrorMessage(err);
        await drop(d, client);
        process.stderr.write(`[ashlr mcp] WARN tools/list("${d.spec.name}") failed: ${safeErrorMessage(err)}\n`);
      }
    })();
    d.inFlight = operation;
    const clearFlight = (): void => { if (d.inFlight === operation) d.inFlight = undefined; };
    void operation.then(clearFlight, clearFlight);
    return operation;
  };

  await Promise.all(downstreams.map((d) => refresh(d, true)));
  const server = new Server({ name: 'ashlr', version: gatewayVersion() }, { capabilities: { tools: {}, resources: {} } });
  const assertUsable = (): void => {
    refuseSharedJobGateway();
    if (closed) throw new Error('MCP gateway is closed');
  };
  server.setRequestHandler(ListResourcesRequestSchema, async () => { assertUsable(); return listFirmResources(); });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => { assertUsable(); return listFirmResourceTemplates(); });
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => { assertUsable(); return readFirmResource(request.params.uri); });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    assertUsable();
    const tools: { name: string; description?: string; inputSchema: unknown }[] = listNativeTools()
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    await Promise.all(downstreams.map((d) => refresh(d)));
    assertUsable();
    // Completion order never changes route precedence or response order.
    for (const d of downstreams) {
      if (!d.client || d.discoveryError !== undefined || !d.hasInventory) continue;
      for (const tool of d.tools) {
        const key = `${d.spec.name}${NS}${tool.name}`;
        if (rejectedRoutes.has(key)) {
          process.stderr.write(`[ashlr mcp] WARN downstream "${key}" has an ambiguous or native tool route — skipped\n`);
          continue;
        }
        const route = routes.get(key);
        if (!route || route.downstream !== d || route.client !== d.client) continue;
        tools.push({ name: key, description: `[${d.spec.name}] ${tool.description ?? tool.name}`, inputSchema: tool.inputSchema ?? { type: 'object' } });
      }
    }
    return {
      tools,
      _meta: {
        'ashlr/discovery': {
          servers: downstreams.map((d) => ({
            name: d.spec.name,
            status: d.discoveryError !== undefined ? (d.hasInventory ? 'stale' : 'unavailable') : 'ready',
            lastKnownToolCount: d.tools.length,
            ...(d.discoveryError !== undefined ? { error: d.discoveryError } : {}),
          })),
          rejectedRoutes: [...rejectedRoutes],
        },
      },
    } as { tools: { name: string; description?: string; inputSchema: object }[]; _meta: Record<string, unknown> };
  });

  server.setRequestHandler(CallToolRequestSchema, unknownToolAsInvalidParams(async (request) => {
    assertUsable();
    const requested = request.params.name;
    if (isNativeTool(requested)) return callNativeTool(requested, request.params.arguments ?? {});
    const route = routes.get(requested);
    if (!route || route.downstream.client !== route.client) {
      const live = [...routes].filter(([, r]) => r.downstream.client === r.client).map(([name, r]) => ({ name, original: r.original }));
      throw new Error(unknownToolMessage(requested, live));
    }
    try {
      return await withDeadline(route.client.callTool({ name: route.original, arguments: request.params.arguments ?? {} }, undefined, { timeout: timeoutMs }), timeoutMs, `tools/call(${route.downstream.spec.name})`);
    } catch (err) {
      await drop(route.downstream, route.client);
      throw err; // never replay an effectful request, even after reconnection
    }
  }));

  let closing: Promise<void> | undefined;
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  const onSighup = (): void => onSignal('SIGHUP');
  let finish: () => void;
  const onDisconnect = (): void => finish();
  let parentWatch: ReturnType<typeof setInterval> | undefined;
  let onSignal: (signal: NodeJS.Signals) => void;
  const closeAll = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGHUP', onSighup);
    process.stdin.removeListener('end', onDisconnect);
    process.stdin.removeListener('close', onDisconnect);
    clearInterval(parentWatch);
    const clients = downstreams.flatMap((d) => {
      d.generation++;
      const client = d.client;
      d.client = null;
      d.tools = [];
      return client ? [client] : [];
    });
    routes.clear();
    // Defer teardown until `closing` is assigned: server.close may call our
    // onclose handler synchronously, and every shutdown path shares this job.
    closing = Promise.resolve().then(async () => {
      await Promise.all([
        Promise.all(clients.map(closeClient)),
        withDeadline(server.close(), timeoutMs, 'gateway close').catch(() => {}),
        Promise.allSettled(downstreams.map((d) => d.inFlight)),
      ]);
    });
    return closing;
  };
  const finished = new Promise<void>((resolve) => {
    finish = (): void => {
      if (closing) return;
      // Bound teardown even if an in-flight connection or SDK close hangs.
      const deadline = setTimeout(() => process.exit(0), 3_000);
      deadline.unref();
      void closeAll().finally(() => clearTimeout(deadline)).then(resolve, resolve);
    };
    server.onclose = finish;
    onSignal = (signal): void => {
      process.stderr.write(`[ashlr mcp] received ${signal} — shutting down\n`);
      finish();
    };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    process.once('SIGHUP', onSighup);
    process.stdin.once('end', onDisconnect);
    process.stdin.once('close', onDisconnect);
    parentWatch = setInterval(() => {
      if (process.ppid !== startupParent) finish();
    }, 5_000);
    parentWatch.unref();
  });
  try {
    await server.connect(new StdioServerTransport());
    if (!closed) process.stderr.write(`[ashlr mcp] gateway ready — ${listNativeTools().length} native ashlr tool(s) + ${routes.size} downstream tool(s) from ${downstreams.filter((d) => d.client).length}/${downstreams.length} server(s)\n`);
    if (process.stdin.readableEnded || process.stdin.destroyed) finish();
    await finished;
  } finally {
    await closeAll();
  }
}
