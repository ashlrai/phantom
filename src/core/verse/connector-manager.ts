/** Phantom-managed gateway connectors. Configuration and credentials stay on disk. */
import { lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// A 160-bit content version, not an authority credential. The public JSON
// sanitizer preserves 40-character content identifiers while scrubbing raw keys.
const revision = (raw: string) => createHash('sha256').update(raw).digest('hex').slice(0, 40);

async function readRegistry(path: string) {
  // Refuse links: this surface only manages the local Phantom registry.
  for (const entry of [dirname(path), path]) {
    try { if ((await lstat(entry)).isSymbolicLink()) throw new Error('unavailable'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; raw = '{}'; }
  const config: unknown = JSON.parse(raw);
  if (!record(config)) throw new Error('unavailable');
  const active = config.mcpServers ?? {};
  const inactive = config.phantomDisabledMcpServers ?? {};
  if (!record(active) || !record(inactive)) throw new Error('unavailable');
  if (Object.keys(active).some((name) => Object.hasOwn(inactive, name))) throw new Error('unavailable');
  return { raw, config, active, inactive };
}

function snapshot(registry: Awaited<ReturnType<typeof readRegistry>>) {
  return {
    revision: revision(registry.raw),
    connectors: [
      ...Object.keys(registry.active).map((name) => ({ name, enabled: true })),
      ...Object.keys(registry.inactive).map((name) => ({ name, enabled: false })),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function connectorRegistryPath(): string { return join(homedir(), '.ashlr', 'settings.json'); }
export async function listConnectors(path = connectorRegistryPath()) { return snapshot(await readRegistry(path)); }

// Serialize writes; revision comparison also refuses stale UI decisions.
let pending: Promise<unknown> = Promise.resolve();
export function setConnectorEnabled(name: string, enabled: boolean, expectedRevision: string, path = connectorRegistryPath()) {
  const work = pending.catch(() => {}).then(async () => {
    const registry = await readRegistry(path);
    if (revision(registry.raw) !== expectedRevision) throw new Error('conflict');
    const source = enabled ? registry.inactive : registry.active;
    const destination = enabled ? registry.active : registry.inactive;
    if (!Object.hasOwn(source, name) || !record(source[name])) throw new Error('conflict');
    Object.defineProperty(destination, name, { value: source[name], enumerable: true, configurable: true, writable: true });
    delete source[name];
    registry.config.mcpServers = registry.active;
    registry.config.phantomDisabledMcpServers = registry.inactive;
    const raw = `${JSON.stringify(registry.config, null, 2)}\n`;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, raw, { mode: 0o600, flag: 'wx' });
      // Refuse changes made while preparing the replacement.
      if ((await readRegistry(path)).raw !== registry.raw) throw new Error('conflict');
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
    return snapshot({ ...registry, raw });
  });
  pending = work;
  return work;
}
