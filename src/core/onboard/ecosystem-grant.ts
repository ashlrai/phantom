/** One explicit, snapshot-bound grant. No imports of credential extraction or runtime authority. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { z } from 'zod';
import { assertMetadata, safePath, updateProfile, type Connector } from '../connectors/profile.js';
import { detectEcosystem, ecosystemContext, ecosystemSeeds, findExecutables, readMetadataFile, type EcosystemCapability, type EcosystemOptions } from './ecosystem.js';

export interface CapabilityReceipt {
  id: string;
  status: 'configured' | 'available' | 'needs-you' | 'failed';
  detail: string;
  next: string | null;
}
export interface EcosystemReceipt {
  schemaVersion: 1;
  phase: 'complete' | 'incomplete';
  grantId: string;
  planId: string;
  results: CapabilityReceipt[];
}
const requestSchema = z.object({
  planId: z.string().regex(/^[a-f0-9]{64}$/),
  selected: z.array(z.string().min(1).max(120)).min(1).max(256),
}).strict();
export type EcosystemGrant = z.infer<typeof requestSchema>;
export interface EcosystemGrantOptions extends EcosystemOptions {
  /** Test seam for capability operations. The grant validates the full selection first. */
  wire?: (capability: EcosystemCapability) => Promise<CapabilityReceipt>;
}
export class EcosystemGrantError extends Error {}

async function atomicMetadata(path: string, value: unknown, home: string): Promise<void> {
  assertMetadata(JSON.stringify(value));
  await safePath(path, home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.onboard-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

async function wireCapability(capability: EcosystemCapability, options: EcosystemOptions): Promise<CapabilityReceipt> {
  const { home, cwd, env, run } = ecosystemContext(options);
  const bins = await findExecutables(env);
  const result = (status: CapabilityReceipt['status'], detail: string, next: string | null = null): CapabilityReceipt => ({ id: capability.id, status, detail, next });
  const connector = async (id: string, command: string): Promise<CapabilityReceipt> => {
    const entry: Connector = { id, command, kind: 'cli', args: [], scopes: [], tools: [], lanes: [], credentials: [] };
    let conflict = false;
    await updateProfile(profile => {
      const existing = profile.connectors.find(c => c.id === id);
      if (existing) { conflict = existing.kind !== 'cli' || existing.command !== command; return profile; }
      return { ...profile, connectors: [...profile.connectors, entry] };
    }, home);
    return conflict ? result('needs-you', 'An existing connector differs; it was preserved.', 'Review with phm connectors list --json') : result('configured', 'CLI registered; login and scoped execution remain with its existing custody.');
  };
  const enableMcp = async (name: string, binary: string, args: string[]): Promise<CapabilityReceipt> => {
    const command = bins.get(binary)?.[0];
    if (!command) return result('needs-you', 'The local MCP executable is missing.', 'Install the companion from its producer, then detect again.');
    const path = join(home, '.ashlr', 'settings.json');
    await safePath(path, home);
    const raw = await readMetadataFile(path);
    if (raw === null && await lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('unreadable settings');
    let settings: Record<string, unknown> = {};
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('unsupported settings');
      settings = parsed as Record<string, unknown>;
    }
    const current = settings.mcpServers;
    if (current !== undefined && (!current || typeof current !== 'object' || Array.isArray(current))) throw new Error('unsupported servers');
    const servers = { ...(current as Record<string, unknown> ?? {}) };
    const spec = { command, args };
    if (servers[name]) {
      return JSON.stringify(servers[name]) === JSON.stringify(spec)
        ? result('configured', 'MCP registration already matches.')
        : result('needs-you', 'An existing MCP registration was preserved.', 'Review with phm mcp doctor --json');
    }
    // Do not copy arbitrary client commands, environment maps, locators or URLs.
    assertMetadata(JSON.stringify(settings));
    if (raw !== null) await writeFile(`${path}.onboard-${randomUUID()}.bak`, raw, { flag: 'wx', mode: 0o600 });
    servers[name] = spec;
    await atomicMetadata(path, { ...settings, mcpServers: servers }, home);
    return result('configured', 'Local MCP registered in the Phantom gateway.', 'Check the companion with phm mcp doctor --json');
  };

  if (capability.action === 'import-offer') {
    const command = capability.id === 'import:1password'
      ? 'phantom import --from 1password --file <private-export.json>'
      : 'phantom import --from env --file <private-export.env>';
    return result('needs-you', 'Import offer accepted. Secrets owns the trusted-terminal import; the wizard never reads exports.', command);
  }
  if (capability.action === 'install-markdown') return result('needs-you', 'Install Ashlr MD using the producer desktop installer for this platform.', 'https://github.com/ashlrai/ashlr-md/releases/latest');
  if (capability.action === 'install-plugin') {
    const npm = bins.get('npm')?.[0];
    if (!npm || !bins.has('bun') || !bins.has('rg')) return result('needs-you', 'Plugin installation needs npm, Bun and ripgrep on PATH.', 'Install these prerequisites, then detect again.');
    const prefix = join(home, '.phantom', 'onboard', 'tools');
    await safePath(join(prefix, 'package.json'), home);
    // Version matches the reviewed repository MCP spec. No arbitrary lifecycle scripts.
    const install = await run(npm, ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', 'ashlr-plugin@1.36.4']);
    if (install.code !== 0) return result('failed', 'Plugin installation failed; package-manager output was withheld.');
    const updatedEnv = { ...env, PATH: join(prefix, 'node_modules', '.bin') + delimiter + (env.PATH ?? '') };
    const installedBins = await findExecutables(updatedEnv);
    if (!installedBins.has('ashlr-mcp')) return result('failed', 'Installed package did not provide its MCP executable.');
    // Reuse the same metadata-only MCP registration path after verifying installation.
    return wireCapability({ ...capability, action: 'enable-mcp' }, { ...options, env: updatedEnv });
  }
  if (capability.id.startsWith('cli:')) {
    const [, name, index] = capability.id.split(':');
    const command = bins.get(name!)?.[Number(index)];
    return command ? connector(`onboard-${name}-${index}`, command) : result('needs-you', 'CLI installation is no longer present.', 'Detect again.');
  }
  if (capability.kind === 'service') {
    const binary = capability.names[0];
    const command = binary ? bins.get(binary)?.[0] : undefined;
    return command ? connector(`onboard-${capability.id.slice(8)}`, command) : result('available', 'Existing MCP connection retained; no configuration copied.');
  }
  if (capability.action === 'seed') {
    const lexicon = bins.get('lexicon')?.[0];
    if (!lexicon) return result('needs-you', 'Lexicon is missing.', 'Install Lexicon, then detect again.');
    for (const term of ecosystemSeeds(cwd).filter(term => !capability.names.includes(term))) {
      const seeded = await run(lexicon, ['add', term, '--project', '--json']);
      if (seeded.code !== 0) return result('failed', 'Lexicon could not seed all project terms; output was withheld.');
    }
    return result('configured', 'Repository and parent organization names seeded in the project vocabulary.');
  }
  if (capability.id === 'vault') {
    if (!['empty', 'populated'].includes(capability.state)) return result('needs-you', 'Vault access is unverified; the existing vault was preserved.', capability.next ?? 'Inspect Phantom Secrets in a trusted terminal: phantom status --json');
    return enableMcp('phantom-secrets', 'phantom', ['mcp', 'serve']);
  }
  if (capability.id === 'locus') return enableMcp('locus', 'locus-mcp', []);
  if (capability.id === 'stack') return enableMcp('stack', 'ashlr-stack-mcp', []);
  if (capability.id === 'plugin') return enableMcp('ashlr', 'ashlr-mcp', []);
  if (capability.kind === 'local-model' && capability.next) {
    const endpoint = new URL(capability.next);
    if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:') throw new Error('non-loopback');
    const path = join(home, '.ashlr', 'config.json');
    await safePath(path, home);
    const raw = await readMetadataFile(path);
    if (raw === null && await lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('unreadable config');
    const { defaultConfig } = await import('../config.js');
    const config = raw === null ? defaultConfig() : JSON.parse(raw);
    const provider = endpoint.port === '11434' ? 'ollama' : 'lmstudio';
    if (!config.models || typeof config.models !== 'object') throw new Error('invalid model config');
    const current: unknown = config.models[provider];
    if (current && current !== defaultConfig().models[provider] && current !== endpoint.origin) return result('needs-you', 'A different local model endpoint is already configured; it was preserved.', 'Choose the endpoint in model settings.');
    config.models[provider] = endpoint.origin;
    await atomicMetadata(path, config, home);
    return result('configured', 'Loopback model endpoint configured; no model was started or downloaded.');
  }
  if (capability.id === 'api-keys') return result('needs-you', 'Binding names approved; credential values were not copied or used.', 'Use Phantom Secrets import in a trusted terminal, then launch tools through phantom exec.');
  if (capability.state === 'missing') return result('needs-you', 'Capability is not installed.', capability.next);
  return result('available', 'Existing capability retained; no credentials or running services changed.');
}

export async function grantEcosystem(input: unknown, options: EcosystemGrantOptions = {}): Promise<EcosystemReceipt> {
  // Refuse secret-shaped and unknown fields before any write or action.
  try { assertMetadata(JSON.stringify(input)); } catch { throw new EcosystemGrantError('Secret-shaped grant refused. Use capability ids only.'); }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success || new Set(parsed.data?.selected).size !== parsed.data?.selected.length) throw new EcosystemGrantError('Expected a planId and a unique, nonempty selected capability list.');
  const request = parsed.data;
  const { home } = ecosystemContext(options);
  const plan = await detectEcosystem(options);
  if (plan.planId !== request.planId) throw new EcosystemGrantError('Detection changed. Review a fresh preview before granting.');
  const selected = request.selected.map(id => plan.capabilities.find(row => row.id === id));
  if (selected.some(row => !row)) throw new EcosystemGrantError('Unknown capability. Review a fresh preview.');
  const grantId = createHash('sha256').update(JSON.stringify({ planId: plan.planId, selected: [...request.selected].sort() })).digest('hex');
  const directory = join(home, '.phantom', 'onboard');
  const path = join(directory, `${grantId}.json`);
  await safePath(path, home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, '.grant-lock');
  try { await mkdir(lock); } catch { throw new EcosystemGrantError('Another onboarding grant is running. Retry after it completes.'); }
  try {
    const prior = await readMetadataFile(path);
    if (prior !== null) { assertMetadata(prior); return JSON.parse(prior) as EcosystemReceipt; }
    const results: CapabilityReceipt[] = [];
    for (const capability of selected as EcosystemCapability[]) {
      try {
        const receipt = await (options.wire ? options.wire(capability) : wireCapability(capability, options));
        assertMetadata(JSON.stringify(receipt));
        results.push(receipt);
      } catch { results.push({ id: capability.id, status: 'failed', detail: 'Wiring failed; private diagnostics were withheld.', next: 'Review this capability and detect again.' }); }
    }
    const receipt: EcosystemReceipt = { schemaVersion: 1, phase: results.every(row => ['configured', 'available'].includes(row.status)) ? 'complete' : 'incomplete', grantId, planId: plan.planId, results };
    await atomicMetadata(path, receipt, home);
    return receipt;
  } finally { await rm(lock, { recursive: true, force: true }); }
}
