/** Isolated MCP adapter: no gateway discovery, forwarding, or mutation tools. */
import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { readFleetRunsDirState } from '../core/fleet/runs-dir-state.js';
import { scrubPrivateText } from '../core/util/scrub.js';
import { MAX_FLEET_TICKS, MAX_FLEET_BUS_HOPS, readFleetLoop, readFleetStatus, readFleetBusHops } from './fleet.js';

export const MAX_FLEET_OUTPUT_BYTES = 64 * 1024;

export interface FleetReaders {
  status: () => Promise<unknown>;
  loop: (limit: number) => Promise<unknown>;
  bus?: (limit: number) => Promise<unknown>;
  hostRuns?: () => Promise<unknown>;
}

/** SDK transport injection permits a real protocol round trip without a child. */
export function createFleetServer(readers: FleetReaders = { status: readFleetStatus, loop: readFleetLoop, bus: readFleetBusHops }): Server {
  // The standalone binary embeds the version; npm/source installs have a
  // package.json. Do not import the mutation-capable gateway just for metadata.
  let version = process.env.ASHLR_VERSION;
  if (!version) {
    try { version = (createRequire(import.meta.url)('../../package.json') as { version: string }).version; }
    catch { /* standalone distributions may not contain a package.json */ }
  }
  const server = new Server({ name: 'phantom-fleet', version: version || '0.0.0-unknown' }, {
    capabilities: { tools: {} },
    instructions: 'Read-only local persisted fleet observations. No tool starts, advances, pauses, or repairs the loop. Unknown or degraded evidence grants no execution authority.',
  });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    {
      name: 'fleet_status',
      description: 'Read persisted fleet daemon liveness, budget, stop controls, backend quota, cached queue and proposal counts. Local-only subset of phm fleet status; no provider probes. Null means unknown, not zero.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
    {
      name: 'fleet_loop',
      description: 'Observe loop liveness, current activity, stop controls, budget and recent tick history (oldest first). Never runs a tick. Reads remain available while KILL is engaged.',
      inputSchema: {
        type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_TICKS, default: 20 } },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_bus_hops',
      description: 'Observe the newest validated cross-agent bus hop metadata (message id, from/to, nullable token usage) in the local hop log, oldest first. A hop is only a recorded send attempt: no bodies, no delivery or lifecycle claims.',
      inputSchema: {
        type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_BUS_HOPS, default: 20 } },
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: 'fleet_host_runs',
      description: 'Read the bounded persisted host runs projection, including launched activity, claims and lane counts. Missing or degraded sources are reported as such; this does not probe providers or establish live worker state.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations,
    },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    // Low-level SDK servers do not validate arguments against tools/list schemas.
    if (name !== 'fleet_status' && name !== 'fleet_loop' && name !== 'fleet_bus_hops' && name !== 'fleet_host_runs') {
      throw new McpError(ErrorCode.InvalidParams, 'Unknown fleet tool.');
    }
    const limited = name === 'fleet_loop' || name === 'fleet_bus_hops';
    const maxLimit = name === 'fleet_bus_hops' ? MAX_FLEET_BUS_HOPS : MAX_FLEET_TICKS;
    const limit = args['limit'] ?? 20;
    if (Object.keys(args).some(key => !limited || key !== 'limit') ||
        (limited && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > maxLimit)) ||
        args['limit'] === null) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid fleet tool arguments.');
    }
    try {
      const value = name === 'fleet_status' ? await readers.status()
        : name === 'fleet_loop' ? await readers.loop(limit as number)
        : name === 'fleet_bus_hops' ? await (readers.bus ?? readFleetBusHops)(limit as number)
        : await (readers.hostRuns ?? readFleetRunsDirState)();
      // Scrub values before serialization: redaction regexes operate on prose
      // and may consume JSON quotes if applied to already serialized bytes.
      const text = JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'string' ? scrubPrivateText(item, { emails: true }) : item,
      );
      // Never slice JSON: oversized observations fail explicitly and remain valid MCP.
      if (Buffer.byteLength(text, 'utf8') > MAX_FLEET_OUTPUT_BYTES) {
        return { isError: true, content: [{ type: 'text', text: 'Fleet observation exceeds the output limit; request a smaller limit.' }] };
      }
      return { content: [{ type: 'text', text }] };
    } catch {
      // Source exceptions may contain config values, tokens, or machine paths.
      return { isError: true, content: [{ type: 'text', text: 'Fleet observation unavailable; inspect local configuration and fleet stores.' }] };
    }
  });
  return server;
}

export async function startFleetServer(): Promise<void> {
  await createFleetServer().connect(new StdioServerTransport());
}
