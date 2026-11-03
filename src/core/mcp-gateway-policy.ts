/** Host-owned gateway policy. Request arguments never supply identity or approval. */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const verdict = z.enum(['deny', 'approval_required', 'allow']);
const schema = z.object({
  ask_before_every_change: z.boolean().default(false),
  read_tools: z.array(z.string().regex(/^.+__.+$/)).default([]),
  policies: z.array(z.object({
    name: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/),
    agents: z.array(z.string()).default([]),
    groups: z.array(z.string()).default([]),
    tools: z.record(z.string().regex(/^.+__.+$/), verdict),
  }).strict()).default([]),
}).strict();
export type GatewayPolicy = z.infer<typeof schema>;
export type GatewayIdentity = { agent?: string; groups: string[] };

export function parseGatewayPolicy(source: string): GatewayPolicy {
  try { return schema.parse(parse(source, { maxAliasCount: 0 })); }
  catch { throw new Error('Invalid MCP gateway policy'); }
}

/** An explicitly configured unreadable file fails startup, never falls back to allow. */
export function loadGatewayPolicy(path = process.env.ASHLR_MCP_POLICY): GatewayPolicy {
  if (path === undefined) return schema.parse({});
  let source: string;
  try { source = readFileSync(path, 'utf8'); }
  catch { throw new Error('Cannot read MCP gateway policy'); }
  return parseGatewayPolicy(source);
}

export function checkGatewayPolicy(policy: GatewayPolicy, identity: GatewayIdentity, tool: string): string | undefined {
  const rank = { deny: 0, approval_required: 1, allow: 2 };
  let selected: { name: string; verdict: z.infer<typeof verdict> } | undefined;
  for (const rule of policy.policies) {
    const applies = (!rule.agents.length && !rule.groups.length)
      || (identity.agent !== undefined && rule.agents.includes(identity.agent))
      || rule.groups.some(group => identity.groups.includes(group));
    const decision = Object.hasOwn(rule.tools, tool) ? rule.tools[tool] : undefined;
    if (applies && decision && (!selected || rank[decision] > rank[selected.verdict])) {
      selected = { name: rule.name, verdict: decision };
    }
  }
  if (selected && selected.verdict !== 'allow') return `Policy ${selected.name}: ${selected.verdict}`;
  if (policy.ask_before_every_change && !policy.read_tools.includes(tool)) {
    return 'Policy ask_before_every_change: approval_required';
  }
  return undefined;
}
