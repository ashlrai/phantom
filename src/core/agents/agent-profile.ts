/** Portable metadata only. Profiles grant no project, transport or spending authority. */
import { mkdir, readFile, writeFile, rename, rm, lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import { assertMetadata, readProfile } from '../connectors/profile.js';

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
const reference = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/);
const refs = z.array(reference).max(128).default([]);
const recipients = z.array(z.string().min(1).max(256)).max(128).default([]);
export const agentProfileSchema = z.object({
  id, version: z.number().int().positive().safe().default(1),
  displayName: z.string().min(1).max(120),
  doctrine: z.string().min(1).max(1024).regex(/\.md$/),
  resourceClass: z.enum(['any', 'codex', 'claude', 'glm', 'local']).default('any'),
  channels: refs, tools: refs, mcpServers: refs, skills: refs,
  policy: z.object({
    send: z.enum(['drafts-only', 'self-only', 'allowlist-auto']).default('drafts-only'),
    perMessageApproval: z.boolean().default(true),
    recipients: z.object({ allow: recipients, deny: recipients }).strict().default({ allow: [], deny: [] }),
    dailyCap: z.number().int().nonnegative().safe().nullable().default(null),
    limitsTodo: z.boolean().default(true),
  }).strict().default({ send: 'drafts-only', perMessageApproval: true, recipients: { allow: [], deny: [] }, dailyCap: null, limitsTodo: true }),
}).strict();
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export function validateAgentProfile(value: unknown): AgentProfile {
  assertMetadata(JSON.stringify(value));
  const result = agentProfileSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid agent profile metadata.');
  return result.data;
}
const root = (home: string): string => join(home, '.phantom', 'agents');
async function safe(home: string, name: string): Promise<string> {
  if (!id.safeParse(name).success) throw new Error('Invalid agent profile id.');
  for (const path of [join(home, '.phantom'), root(home), join(root(home), `${name}.toml`)]) {
    try { const stat = await lstat(path); if (stat.isSymbolicLink()) throw new Error('Symlinked agent profiles refused.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return join(root(home), `${name}.toml`);
}
export async function readAgentProfile(name: string, home = homedir()): Promise<AgentProfile> {
  const path = await safe(home, name);
  const info = await lstat(path);
  if (!info.isFile() || info.size > 256 * 1024) throw new Error('Agent profile must be a bounded regular file.');
  const text = await readFile(path, 'utf8');
  assertMetadata(text);
  const profile = validateAgentProfile(parse(text));
  if (profile.id !== name) throw new Error('Agent profile id mismatch.');
  return profile;
}
export async function listAgentProfiles(home = homedir()): Promise<AgentProfile[]> {
  await safe(home, 'inventory');
  let names: string[];
  try { names = await readdir(root(home)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return Promise.all(names.filter(n => n.endsWith('.toml')).sort().map(n => readAgentProfile(n.slice(0, -5), home)));
}
/** Serialized atomic writes. Caller version is an optimistic concurrency token. */
export async function writeAgentProfile(value: unknown, home = homedir()): Promise<AgentProfile> {
  const candidate = validateAgentProfile(value);
  const path = await safe(home, candidate.id);
  await mkdir(root(home), { recursive: true, mode: 0o700 });
  const lock = join(root(home), '.write-lock');
  await mkdir(lock, { mode: 0o700 });
  const tmp = join(root(home), `.profile-${randomUUID()}.tmp`);
  try {
    const connectors = await readProfile(home);
    if (candidate.mcpServers.some(ref => !connectors.connectors.some(c => c.id === ref))) throw new Error('Unknown connector profile id.');
    let previous: AgentProfile | undefined;
    try { previous = await readAgentProfile(candidate.id, home); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous) {
      if (previous.version !== candidate.version) throw new Error('Stale agent profile version.');
      if (JSON.stringify(previous) === JSON.stringify(candidate)) return previous;
      candidate.version = previous.version + 1;
      const history = await historyPath(candidate.id, previous.version, home, true);
      const { dailyCap: oldCap, ...oldPolicy } = previous.policy;
      const oldText = stringify({ ...previous, policy: { ...oldPolicy, ...(oldCap === null ? {} : { dailyCap: oldCap }) } });
      try { await writeFile(history, oldText, { mode: 0o600, flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || JSON.stringify(await readRevision(history, previous.id, previous.version)) !== JSON.stringify(previous)) throw new Error('Agent profile history conflict.');
      }
    } else if (candidate.version !== 1) throw new Error('New agent profiles start at version 1.');
    validateAgentProfile(candidate);
    // TOML has no null. Omit dailyCap when unlimited; the schema restores null.
    const { dailyCap, ...policy } = candidate.policy;
    const encoded = stringify({ ...candidate, policy: { ...policy, ...(dailyCap === null ? {} : { dailyCap }) } });
    await writeFile(tmp, encoded, { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
    return candidate;
  } finally { await rm(tmp, { force: true }); await rm(lock, { recursive: true, force: true }); }
}
async function historyPath(name: string, version: number, home: string, create = false): Promise<string> {
  await safe(home, name);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid profile version.');
  const dir = join(root(home), `${name}.versions`);
  try { if (!(await lstat(dir)).isDirectory()) throw new Error('Invalid profile history directory.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; if (create) await mkdir(dir, { mode: 0o700 }); }
  const path = join(dir, `${version}.toml`);
  try { if (!(await lstat(path)).isFile()) throw new Error('Invalid profile revision.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return path;
}
async function readRevision(path: string, name: string, version: number): Promise<AgentProfile> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 256 * 1024) throw new Error('Invalid profile revision.');
  const text = await readFile(path, 'utf8');
  assertMetadata(text);
  const profile = validateAgentProfile(parse(text));
  if (profile.id !== name || profile.version !== version) throw new Error('Profile revision mismatch.');
  return profile;
}
export async function agentProfileVersions(name: string, home = homedir()): Promise<number[]> {
  const current = await readAgentProfile(name, home);
  await historyPath(name, current.version, home);
  let names: string[];
  try { names = await readdir(join(root(home), `${name}.versions`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [current.version]; throw error; }
  const versions = [current.version];
  for (const file of names) {
    if (!/^[1-9][0-9]*\.toml$/.test(file)) continue;
    const version = Number(file.slice(0, -5));
    if (version >= current.version) continue;
    await readRevision(await historyPath(name, version, home), name, version);
    versions.push(version);
  }
  return versions.sort((a, b) => a - b);
}
/** Sessions and jobs must retain both fields and resolve that exact revision. */
export async function pinAgentProfile(name: string, version: number, home = homedir()): Promise<AgentProfile> {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid pinned profile version.');
  const profile = await readAgentProfile(name, home);
  if (profile.version === version) return profile;
  if (version > profile.version) throw new Error('Pinned agent profile version unavailable.');
  return readRevision(await historyPath(name, version, home), name, version);
}
