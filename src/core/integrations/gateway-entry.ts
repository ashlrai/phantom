/**
 * One identity for the Phantom CLI MCP gateway entry in editor registries.
 *
 * `phm wire claude` and `phm mcp install claude` both register the gateway in
 * ~/.claude.json. They must converge on a single server key so a user who runs
 * both does not get the gateway's tool set twice.
 *
 * The canonical key is `ashlr-hub`: the bare `ashlr` key also belongs to the
 * separate ashlr-plugin MCP server, so writing it could clobber that plugin.
 * An `ashlr` entry is migrated (removed) only when it structurally launches
 * this product's own gateway binary; any other `ashlr` entry is left alone.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** Canonical MCP server key for the Phantom CLI gateway. */
export const GATEWAY_MCP_SERVER = 'ashlr-hub';

/** Legacy key `phm mcp install claude` wrote before convergence. */
export const LEGACY_GATEWAY_MCP_SERVER = 'ashlr';

/** Executable names this package installs (package.json `bin`). */
const OWN_BIN_NAMES = new Set(['ashlr', 'phm']);

/** Package names this product has shipped under. */
const OWN_PACKAGE_NAMES = new Set(['@ashlr/phantom', '@ashlr/hub']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commandBasename(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(?:cmd|exe)$/i, '');
}

function hasPathSeparator(command: string): boolean {
  return /[\\/]/.test(command);
}

function packageOwnsBinary(command: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dirname(dirname(command)), 'package.json'), 'utf8'),
    ) as unknown;
    return isRecord(manifest)
      && typeof manifest['name'] === 'string'
      && OWN_PACKAGE_NAMES.has(manifest['name']);
  } catch {
    return false;
  }
}

/**
 * True when an mcpServers entry launches this product's own gateway:
 * args exactly `['mcp']`, no env, stdio (or untyped), and a command that is
 * either a bare `ashlr`/`phm` (PATH lookup) or an absolute path to a `bin/ashlr`
 * or `bin/phm` inside a checkout/install of this package.
 */
export function isOwnGatewayEntry(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const { command, args, env, type } = entry;
  if (typeof command !== 'string' || command.length === 0) return false;
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== 'mcp') return false;
  if (type !== undefined && type !== 'stdio') return false;
  if (env !== undefined && (!isRecord(env) || Object.keys(env).length > 0)) return false;
  if (!OWN_BIN_NAMES.has(commandBasename(command))) return false;
  if (!hasPathSeparator(command)) return true;
  return isAbsolute(command) && packageOwnsBinary(command);
}

/** Legacy keys in `servers` that hold this product's gateway and may be removed. */
export function legacyGatewayKeys(servers: Record<string, unknown>): string[] {
  return Object.prototype.hasOwnProperty.call(servers, LEGACY_GATEWAY_MCP_SERVER)
    && isOwnGatewayEntry(servers[LEGACY_GATEWAY_MCP_SERVER])
    ? [LEGACY_GATEWAY_MCP_SERVER]
    : [];
}
