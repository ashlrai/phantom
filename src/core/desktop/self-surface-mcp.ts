/**
 * Native MCP tools for the self-surface (core/verse/self-surface.ts): Phantom
 * reads and drives its own window through the running console, not screen
 * pixels. Writes are `append`, so callNativeTool refuses them under KILL; the
 * console also refuses them under KILL and comms pause and posts every
 * request to the bus before it runs.
 */
import type { AshlrConfig, NativeToolDef } from '../types.js';
import { runSelfCheck, sendSelfRequest } from '../verse/self-surface-agent.js';

type Tool = NativeToolDef & { handler: (args: Record<string, unknown>, cfg: AshlrConfig) => Promise<unknown> };

const str = (args: Record<string, unknown>, key: string): string | undefined => (typeof args[key] === 'string' ? args[key] as string : undefined);
const schema = (properties: object, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const selfSurfaceTools: Tool[] = [
  {
    name: 'self_snapshot',
    description: "Snapshot Phantom's own current screen: route, title, viewport, overflow, console errors and up to 400 landmarks, headings and controls with role, name and stable id. Input values are never read. Works when the window is hidden. Read-only.",
    inputSchema: schema({}),
    safety: 'read',
    handler: async () => sendSelfRequest({ verb: 'snapshot' }),
  },
  {
    name: 'self_screenshot',
    description: "Render Phantom's own webview to a PNG. Local-only by default: returns a private 0600 path, no bytes. Read-only.",
    inputSchema: schema({ include_image: { type: 'boolean', description: 'Also return the base64 PNG for this call. Pixels are not secret-scrubbed. Default false.' } }),
    safety: 'read',
    handler: async (args) => sendSelfRequest({ verb: 'screenshot', ...(args['include_image'] === true ? { includeImage: true } : {}) }),
  },
  {
    name: 'self_navigate',
    description: 'Open a Phantom section (command, fleet, growth, mind, chat, agents, settings, ...). Posts a bus intent first; refused under KILL or comms pause.',
    inputSchema: schema({ section: { type: 'string' }, anchor: { type: 'string', description: 'Optional in-section anchor, e.g. desktop-updates.' } }, ['section']),
    safety: 'append',
    handler: async (args) => sendSelfRequest({ verb: 'navigate', section: str(args, 'section'), ...(str(args, 'anchor') ? { anchor: str(args, 'anchor') } : {}) }),
  },
  {
    name: 'self_act',
    description: 'Click or focus the Phantom element with a stable id (data-testid, data-section, data-verse-anchor, data-settings-group or an exact aria-label). Password fields are refused. Posts a bus intent first; refused under KILL or comms pause.',
    inputSchema: schema({ test_id: { type: 'string' }, action: { type: 'string', enum: ['click', 'focus'] } }, ['test_id']),
    safety: 'append',
    handler: async (args) => sendSelfRequest({ verb: 'act', testId: str(args, 'test_id'), action: str(args, 'action') ?? 'click' }),
  },
  {
    name: 'self_check',
    description: "Post-release self-check: open each main Phantom screen, snapshot and capture it, and flag console errors, loads over 2 s, horizontal overflow, empty screens and node-count or height drift over 40% against the local baseline.",
    inputSchema: schema({ update_baseline: { type: 'boolean', description: 'Record this run as the new baseline.' } }),
    safety: 'append',
    handler: async (args) => runSelfCheck({ updateBaseline: args['update_baseline'] === true }),
  },
];
