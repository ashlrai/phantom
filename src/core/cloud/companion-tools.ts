/**
 * The companion-tools block for cloud task prompts: which of Phantom's sibling
 * MCP servers the repository's tracked `.mcp.json` declares, and when a cloud
 * session should call each one.
 *
 * A cloud session on a repository sees its `.mcp.json` like any Claude Code
 * session, but nothing in the task prompt tells it the servers exist or what
 * they are for, so a session that writes code never runs `phantom_check` and
 * never asks Locus who is pinned. The block names only servers the file
 * declares; an unreadable, missing or foreign file yields '' and the prompt
 * goes out unchanged. Guidance only: it grants no tool and changes no sandbox.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_MCP_JSON_BYTES = 64 * 1024;

/** Known companion servers, in the order the block lists them, with when to use each. */
const COMPANION_GUIDANCE: readonly { name: string; tools: string; when: string }[] = [
  {
    name: 'phantom-secrets',
    tools: '`phantom_check`',
    when: 'before every commit, to confirm no raw secret is staged; values never reach you, so never ask for one',
  },
  {
    name: 'locus',
    tools: '`locus_whoami`, `locus_safe_next`',
    when: 'before any step that acts as an account (a provider CLI, a deploy, a publish); "no active pin" means do not act as any account, and say so in the report',
  },
  {
    name: 'lexicon',
    tools: '`normalize_transcript`',
    when: 'on the task text when it reads like dictation (misspelled product names), before you act on it',
  },
  {
    name: 'stack',
    tools: '`stack_status`, `stack_doctor`',
    when: 'read-only, to see which services the project uses; never call `stack_add` or `stack_apply`',
  },
];

/** Server names declared in `<checkout>/.mcp.json`, or [] when the file is absent or unreadable. */
export function declaredMcpServers(checkoutPath: string): string[] {
  const path = join(checkoutPath, '.mcp.json');
  try {
    if (!existsSync(path) || statSync(path).size > MAX_MCP_JSON_BYTES) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
    return Object.keys(servers);
  } catch {
    return [];
  }
}

/** The prompt block for the companion servers among `servers`, or '' when there are none. */
export function companionToolsBlock(servers: readonly string[]): string {
  const present = COMPANION_GUIDANCE.filter(c => servers.includes(c.name));
  if (present.length === 0) return '';
  return [
    'COMPANION TOOLS (declared in this repository\'s .mcp.json)',
    '',
    ...present.map(c => `- \`${c.name}\`: ${c.tools} ${c.when}.`),
    '',
    'If a server is not available in your session, carry on without it. In the report, list the companion tools you actually called in "toolsUsed" (an empty list if none), and note any server that was unavailable under "risks".',
  ].join('\n');
}

/** Convenience for the launch path: the block for a checkout's `.mcp.json`. */
export function companionToolsBlockFor(checkoutPath: string): string {
  return companionToolsBlock(declaredMcpServers(checkoutPath));
}
