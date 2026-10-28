/** Shared tools contracts. Public entry point: ../types.ts. */

// ---------------------------------------------------------------------------
// M3: MCP aggregation gateway + ecosystem tools registry contract
// ---------------------------------------------------------------------------

/** A single discovered MCP server spec (one entry under an "mcpServers" map). */
export interface McpServerSpec {
  /** Unique server name (dedupe key across all discovered configs). */
  name: string;
  /** Executable to launch the stdio MCP server. */
  command: string;
  /** Arguments passed to `command`. */
  args: string[];
  /** Environment overrides for the child process. Values redacted when printed. */
  env?: Record<string, string>;
  /** Where this spec was discovered (config path / logical source label). */
  source: string;
}

/** All MCP servers discovered on this machine, deduped by name. */
export interface McpRegistry {
  /** Discovered server specs in stable order. */
  servers: McpServerSpec[];
}

/** One downstream tool surfaced through the gateway, namespaced for routing. */
export interface AggregatedTool {
  /** Owning downstream server name. */
  server: string;
  /** Original (downstream) tool name. */
  name: string;
  /** Gateway-facing name: `<server>__<tool>`. */
  namespaced: string;
  /** Tool description as reported by the downstream, if any. */
  description?: string;
}

/** Health probe result for a single downstream MCP server. */
export interface McpServerHealth {
  /** Server name probed. */
  name: string;
  /** Whether the server started and listed its tools successfully. */
  ok: boolean;
  /** Number of tools the server exposes (0 when not ok). */
  toolCount: number;
  /** Tool names reported by the server (empty when not ok). */
  tools: string[];
  /** Failure reason when `ok` is false, else absent. */
  error?: string;
}

/** Detection result for a single ecosystem CLI tool. */
export interface ToolInfo {
  /** Stable tool id (e.g. 'phantom', 'ashlr-plugin', 'stack'). */
  id: string;
  /** Display name for the tool. */
  name: string;
  /** Whether the tool was found (on PATH, as an app bundle, or in Claude Code's plugin cache). */
  installed: boolean;
  /** Reported version string, or null if unknown/not installed. */
  version: string | null;
  /** Resolved executable, app bundle or cached plugin directory, or null if not installed. */
  path: string | null;
}

/** Roll-up of all detected ecosystem tools. */
export interface ToolsRegistry {
  /** All probed tools in display order. */
  tools: ToolInfo[];
  /** Count of tools where `installed` is true. */
  installedCount: number;
}

// ---------------------------------------------------------------------------
// M10: config -> env bridge (ecosystem cohesion) contract
// ---------------------------------------------------------------------------

/**
 * A flat map of environment-variable name -> value. Used by the env-bridge
 * (core/env-bridge.ts) to project the unified ~/.ashlr/config.json into the
 * environment of spawned ecosystem tools. NON-SECRET ONLY - endpoints, model
 * names, paths, and flags. Never carries secret VALUES (phantom owns secrets).
 */
export type ToolEnv = Record<string, string>;

// ---------------------------------------------------------------------------
// M31 - Agent-native surface: orient + native MCP tools
// ---------------------------------------------------------------------------

/**
 * M31: safety classification of a native MCP tool. The gate is STRUCTURAL -
 * `callNativeTool` enforces it before any handler runs:
 *   'read'     - pure read of local stores; allowed even when the kill switch is on.
 *   'append'   - append-only write under ~/.ashlr/ (genome hub); REFUSED when KILL.
 *   'proposal' - creates a PENDING inbox Proposal; REFUSED when KILL. There is
 *                deliberately NO 'approve'/'apply' class - approval is human-only.
 */
export type NativeToolSafety = 'read' | 'append' | 'proposal' | 'write' | 'exec';
// M42 extends the M31 set (additive - the structural gate `safety !== 'read'`
// already refuses the new classes under KILL):
//   'write' - mutates a workspace path (sandbox worktree); REFUSED under KILL,
//             boundary- + enrollment-gated. Opt-in via `ashlr run --engineer`.
//   'exec'  - runs a subprocess (bash/tests) confined to the sandbox worktree;
//             REFUSED under KILL; double opt-in via `--engineer --bash`.

/**
 * M31: one native tool served by the MCP gateway itself (SDK-free definition;
 * the gateway is the only adapter). `inputSchema` is plain JSON Schema.
 */
export interface NativeToolDef {
  /** Tool name, `ashlr_<verb>` - single underscore; downstream tools are `<server>__<tool>`. */
  name: string;
  /** Human/agent-facing description shown in tools/list. */
  description: string;
  /** JSON Schema for the arguments (always `type: 'object'`). */
  inputSchema: object;
  /** Safety class enforced by the call pipeline (see NativeToolSafety). */
  safety: NativeToolSafety;
}
