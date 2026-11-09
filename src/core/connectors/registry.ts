/**
 * Shared, self-expanding tool registry. Agents create declarative entries that
 * any lane can discover and invoke. Entries are data, never code: a `skill`
 * renders an instruction template; a `connector-call` can only route through
 * runConnector, so it inherits that gate. Nothing here starts a process,
 * resolves a credential or grants authority. Entries are revocable.
 */
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConnectorError, assertMetadata, name, readProfile, safePath, validateProfile } from './profile.js';
import { runConnector } from './run.js';
import { isNativeTool } from '../mcp-native.js';

const fail = (message: string): never => { throw new ConnectorError(message); };
const MAX_ENTRIES = 256;
const MAX_VALUE = 2000;
const PLACEHOLDER = /\{\{([a-zA-Z][a-zA-Z0-9_]{0,39})\}\}/g;
const param = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);

const base = {
  id: name,
  description: z.string().min(1).max(500),
  createdBy: name,
  createdAt: z.string().max(40),
  params: z.array(param).max(16).default([]),
  lanes: z.array(name).max(128).default([]),
  status: z.enum(['active', 'revoked']).default('active'),
  revocation: z.object({ at: z.string().max(40), reason: z.string().max(300) }).strict().optional(),
};
const skill = z.object({ ...base, kind: z.literal('skill'), template: z.string().min(1).max(4000) }).strict();
const call = z.object({
  ...base, kind: z.literal('connector-call'), connector: name,
  selectors: z.object({ scope: name, tool: name, lane: name }).strict(),
  argTemplate: z.array(z.string().max(512)).max(32),
}).strict();
const entry = z.discriminatedUnion('kind', [skill, call]);
const file = z.object({ version: z.literal(1), tools: z.array(entry).max(MAX_ENTRIES) }).strict();
export type RegistryTool = z.infer<typeof entry>;
export type ToolRegistry = z.infer<typeof file>;

/** Input accepted from agents; provenance and status are assigned here, never trusted. */
export type NewTool = { kind: 'skill'; template: string } & NewCommon
  | { kind: 'connector-call'; connector: string; selectors: { scope: string; tool: string; lane: string }; argTemplate: string[] } & NewCommon;
interface NewCommon { id: string; description: string; createdBy: string; params?: string[]; lanes?: string[] }

export const registryPath = (home = homedir()): string => join(home, '.phantom', 'connectors', 'registry.json');

const placeholders = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map(m => m[1]!);
function render(text: string, values: Record<string, string>): string {
  // Single pass: substituted values are never re-expanded.
  return text.replace(PLACEHOLDER, (_, key: string) => values[key]!);
}

async function validate(value: unknown, home: string, checkConnector: boolean): Promise<ToolRegistry> {
  assertMetadata(JSON.stringify(value));
  const parsed = file.safeParse(value);
  if (!parsed.success) fail('Invalid tool registry entry. Run phm connectors tool --help.');
  const registry = parsed.data!;
  const ids = new Set<string>();
  const profile = checkConnector ? await readProfile(home) : null;
  for (const t of registry.tools) {
    if (ids.has(t.id)) fail('Duplicate tool id. Revoke or remove the existing entry first.');
    ids.add(t.id);
    if (isNativeTool(t.id)) fail('Tool id collides with a native gateway tool.');
    if (new Set(t.params).size !== t.params.length) fail('Parameter names must be unique.');
    const used = t.kind === 'skill' ? placeholders(t.template) : t.argTemplate.flatMap(placeholders);
    if (used.some(p => !t.params.includes(p))) fail('Template uses a placeholder that is not a declared parameter.');
    if (t.kind === 'connector-call' && profile) {
      const c = profile.connectors.find(x => x.id === t.connector);
      if (!c || c.kind !== 'cli') fail('connector-call requires an existing cli connector in the profile.');
      // Credential-shaped argument templates are refused by the connector boundary.
      validateProfile({ version: 1, connectors: [{ ...c!, args: [...c!.args, ...t.argTemplate] }] });
    }
  }
  return registry;
}

export async function readRegistry(home = homedir()): Promise<ToolRegistry> {
  await safePath(registryPath(home), home);
  let text: string;
  try { text = await readFile(registryPath(home), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tools: [] }; fail('Cannot read tool registry. Check file permissions.'); }
  let data: unknown;
  try { data = JSON.parse(text!); } catch { fail('Invalid tool registry JSON. Remove ~/.phantom/connectors/registry.json to reset.'); }
  return validate(data, home, false);
}

/** Exclusive directory lease plus atomic rename, as for the connector profile. */
async function update(change: (r: ToolRegistry) => ToolRegistry, home: string): Promise<ToolRegistry> {
  const dir = join(home, '.phantom', 'connectors');
  await safePath(registryPath(home), home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, '.registry-lock');
  try { await mkdir(lock); } catch { fail('Registry is locked. Retry; after an interrupted writer, remove ~/.phantom/connectors/.registry-lock.'); }
  const tmp = join(dir, `.registry-${randomUUID()}.tmp`);
  try {
    const next = await validate(change(await readRegistry(home)), home, true);
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(tmp, registryPath(home));
    return next;
  } finally { await rm(tmp, { force: true }); await rm(lock, { recursive: true, force: true }); }
}

/** `createdBy` is a caller-declared label for attribution, not an authenticated identity. */
export async function createTool(input: NewTool, home = homedir(), now = new Date()): Promise<RegistryTool> {
  const { revocation: _ignored, ...rest } = input as NewTool & { revocation?: unknown };
  const tool = { ...rest, params: input.params ?? [], lanes: input.lanes ?? [], status: 'active', createdAt: now.toISOString() } as RegistryTool;
  const next = await update(r => ({ ...r, tools: [...r.tools, tool] }), home);
  return next.tools.find(t => t.id === tool.id)!;
}

export async function revokeTool(id: string, reason: string, home = homedir(), now = new Date()): Promise<void> {
  assertMetadata(reason);
  await update(r => {
    if (!r.tools.some(t => t.id === id)) fail('Tool not found. Run phm connectors tool list.');
    return { ...r, tools: r.tools.map(t => t.id === id ? { ...t, status: 'revoked' as const, revocation: { at: now.toISOString(), reason: reason.slice(0, 300) } } : t) };
  }, home);
}

export async function removeTool(id: string, home = homedir()): Promise<void> {
  await update(r => {
    if (!r.tools.some(t => t.id === id)) fail('Tool not found. Run phm connectors tool list.');
    return { ...r, tools: r.tools.filter(t => t.id !== id) };
  }, home);
}

const visibleTo = (t: RegistryTool, lane?: string): boolean => !lane || t.lanes.length === 0 || t.lanes.includes(lane);

/** Active entries visible to a lane (all lanes when `lane` is omitted). Revoked entries are never discoverable. */
export async function discoverTools(home = homedir(), lane?: string): Promise<RegistryTool[]> {
  return (await readRegistry(home)).tools.filter(t => t.status === 'active' && visibleTo(t, lane));
}

export type InvokeResult =
  | { kind: 'skill'; tool: string; createdBy: string; untrusted: true; text: string };

/**
 * Skills return rendered text flagged untrusted (agent-authored, so callers must
 * not treat it as an instruction from the owner). connector-call delegates to
 * runConnector and so is currently denied pending Security review.
 */
export async function invokeTool(id: string, lane: string, values: Record<string, string>, home = homedir()): Promise<InvokeResult> {
  const t = (await readRegistry(home)).tools.find(x => x.id === id);
  if (!t || t.status !== 'active') return fail('Tool not found or revoked. Run phm connectors tool list.');
  if (!visibleTo(t, lane)) return fail('Tool is not available to this lane.');
  const keys = Object.keys(values);
  if (keys.length !== t.params.length || keys.some(k => !t.params.includes(k))) fail(`Supply exactly these parameters: ${t.params.join(', ') || '(none)'}.`);
  for (const v of Object.values(values)) {
    if (typeof v !== 'string' || v.length > MAX_VALUE) fail('Parameter values must be strings up to 2000 characters.');
    assertMetadata(v);
    if (t.kind === 'connector-call' && v.startsWith('-')) fail('Parameter values for connector-call may not start with "-".');
  }
  if (t.kind === 'skill') return { kind: 'skill', tool: t.id, createdBy: t.createdBy, untrusted: true, text: render(t.template, values) };
  return runConnector(t.connector, t.selectors, t.argTemplate.map(a => render(a, values)), home);
}
