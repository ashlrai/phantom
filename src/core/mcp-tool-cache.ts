/** Disposable inventory cache: tool names/schemas only; no spec or environment values. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerSpec } from './types.js';

type Inventory = { name: string; inputSchema?: unknown }[];
const MAX_AGE = 24 * 60 * 60 * 1000;

/** Local file identity and package version, without executing a server to ask. */
function identity(file: string): unknown {
  const stat = statSync(file);
  let dir = dirname(file);
  let version: unknown;
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [file, stat.size, stat.mtimeMs, stat.ctimeMs, version];
}

export function toolCachePath(spec: McpServerSpec, env: Record<string, string>): string | undefined {
  try {
    const command = isAbsolute(spec.command) || spec.command.includes('/') || spec.command.includes('\\')
      ? resolve(spec.command)
      : (env.PATH ?? '').split(delimiter).map(dir => resolve(dir, spec.command)).find(file => existsSync(file));
    if (!command) return undefined; // unresolved executable: always attempt discovery
    const files = [identity(command), ...spec.args.filter(arg => !arg.startsWith('-') && existsSync(arg)).map(arg => identity(resolve(arg)))];
    // Environment changes invalidate inventory, but only a digest reaches disk.
    const key = createHash('sha256').update(JSON.stringify([
      1, spec.name, spec.command, spec.args, Object.entries(env).sort(([a], [b]) => a.localeCompare(b)), files,
    ])).digest('hex');
    return join(homedir(), '.ashlr', 'cache', 'mcp-tools', `${key}.json`);
  } catch { return undefined; }
}

export function readToolCache(path: string | undefined): Inventory | undefined {
  if (!path) return undefined;
  try {
    if (statSync(path).size > 4 * 1024 * 1024) return undefined;
    const entry = JSON.parse(readFileSync(path, 'utf8')) as { writtenAt: number; tools: unknown[] };
    const age = Date.now() - entry.writtenAt;
    if (!Number.isFinite(age) || age < 0 || age >= MAX_AGE || !Array.isArray(entry.tools) || entry.tools.length > 4096) return undefined;
    const tools = entry.tools.map(tool => ToolSchema.parse(tool)).map(({ name, inputSchema }) => ({ name, inputSchema }));
    if (tools.some(tool => !tool.name.trim()) || new Set(tools.map(tool => tool.name)).size !== tools.length) return undefined;
    return tools;
  } catch { return undefined; }
}

export function writeToolCache(path: string | undefined, tools: Inventory): void {
  if (!path) return;
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify({ writtenAt: Date.now(), tools: tools.map(({ name, inputSchema }) => ({ name, inputSchema: inputSchema ?? { type: 'object' } })) }), { mode: 0o600 });
    renameSync(temp, path);
  } catch { /* Cache failure must not prevent gateway use. */ }
  finally { try { unlinkSync(temp); } catch { /* renamed or not created */ } }
}
