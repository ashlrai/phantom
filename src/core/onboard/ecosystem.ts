/** Read-only ecosystem discovery. Reports metadata only; never executes a model. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { assertMetadata, safePath } from '../connectors/profile.js';

export type CapabilityKind = 'subscription' | 'api-key' | 'local-model' | 'vault' | 'locus' | 'lexicon' | 'mcp' | 'service' | 'plugin' | 'markdown' | 'import';
export interface EcosystemCapability {
  id: string;
  label: string;
  kind: CapabilityKind;
  state: 'detected' | 'missing' | 'unknown' | 'locked' | 'empty' | 'populated';
  names: string[];
  selected: boolean;
  action: 'register' | 'seed' | 'enable-mcp' | 'install-plugin' | 'install-markdown' | 'import-offer';
  next: string | null;
}
export interface EcosystemPlan {
  schemaVersion: 1;
  phase: 'preview';
  planId: string;
  capabilities: EcosystemCapability[];
}
export interface ProbeResult { code: number | null; stdout: string; stderr: string }
export interface EcosystemOptions {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected transport for hermetic tests. Never receives credential values as arguments. */
  run?: (command: string, args: string[]) => Promise<ProbeResult>;
  probe?: (url: string) => Promise<boolean>;
  applicationRoots?: string[];
  read?: (path: string) => Promise<string | null>;
}
const MAX_BYTES = 262_144;
const PROVIDERS = ['claude', 'codex', 'grok', 'devin'] as const;
export const API_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'DEVIN_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GITHUB_TOKEN', 'SUPABASE_ACCESS_TOKEN', 'VERCEL_TOKEN'] as const;
const LOOPBACK = ['http://127.0.0.1:8123/v1/models', 'http://127.0.0.1:8000/v1/models', 'http://127.0.0.1:1234/v1/models', 'http://127.0.0.1:11434/api/tags'];

export function metadataName(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value)) return false;
  try { assertMetadata(value); return true; } catch { return false; }
}
export function namesOnly(values: unknown[]): string[] {
  return [...new Set(values.filter(metadataName))].sort().slice(0, 256);
}
/** No symlinks, devices, unbounded files or parser diagnostics cross the read boundary. */
export async function readMetadataFile(path: string): Promise<string | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead > MAX_BYTES ? null : buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return null; } finally { await file?.close(); }
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function json(raw: string): unknown { try { return JSON.parse(raw); } catch { return null; } }

/** Only absolute PATH entries; discover every distinct provider installation. No login probes. */
export async function findExecutables(env: NodeJS.ProcessEnv): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const dir of [...new Set((env.PATH ?? '').split(delimiter).filter(isAbsolute))].slice(0, 64)) {
    let entries: string[];
    try { entries = await readdir(dir); } catch { continue; }
    for (const entry of entries.sort().filter(name => /^(?:(?:claude|codex|grok|devin)(?:-[a-z0-9_-]+)?|phantom|locus|locus-mcp|lexicon|stack|ashlr-stack-mcp|ashlr-plugin|ashlr-mcp|mdopen|mdopener-mcp|supabase|vercel|gh|op|bw|npm|bun|rg)$/.test(name)).slice(0, 128)) {
      try {
        const path = await realpath(join(dir, entry));
        assertMetadata(path);
        await access(path, constants.X_OK);
        const paths = found.get(entry) ?? [];
        if (!paths.includes(path)) found.set(entry, [...paths, path]);
      } catch { /* unavailable or secret-shaped executable path */ }
    }
  }
  return found;
}
export function ecosystemContext(options: EcosystemOptions = {}) {
  const home = resolve(options.home ?? homedir());
  const cwd = resolve(options.cwd ?? process.cwd());
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), ...(options.home ? { HOME: home, USERPROFILE: home } : {}) };
  const run = options.run ?? ((command: string, args: string[]) => new Promise<ProbeResult>(resolveResult => {
    const child = execFile(command, args, { cwd, env: { ...env, PHANTOM_NO_UPDATE_CHECK: '1', CI: '1' }, timeout: args[0] === 'install' ? 60_000 : 1500, maxBuffer: MAX_BYTES },
      (error, stdout, stderr) => resolveResult({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr }));
    child.stdin?.end();
  }));
  return { home, cwd, env, run };
}
export async function probeEcosystemLoopback(url: string): Promise<boolean> {
  // Fixed endpoints, no redirects, proxy, ambient auth or response body capture.
  if (!LOOPBACK.includes(url)) return false;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(600), redirect: 'error' });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}

export async function detectEcosystem(options: EcosystemOptions = {}): Promise<EcosystemPlan> {
  const { home, cwd, env, run } = ecosystemContext(options);
  const read = options.read ?? readMetadataFile;
  const bins = await findExecutables(env);
  const rows: EcosystemCapability[] = [];
  const add = (id: string, label: string, kind: CapabilityKind, state: EcosystemCapability['state'], names: string[], action: EcosystemCapability['action'] = 'register', next: string | null = null, selected = state === 'detected') => {
    rows.push({ id, label, kind, state, names: namesOnly(names), action, next, selected });
  };
  for (const provider of PROVIDERS) {
    const instances = [...bins].filter(([name]) => name === provider || name.startsWith(provider + '-'));
    // An installation is an account candidate, not proof of a subscription or login.
    for (const [name, paths] of instances) for (let i = 0; i < paths.length; i++) {
      add(`cli:${name}:${i}`, `${name} installation ${i + 1}`, 'subscription', 'detected', [name]);
    }
    if (!instances.length) add(`cli:${provider}:missing`, provider, 'subscription', 'missing', []);
  }

  const keyNames = new Set<string>(API_NAMES.filter(name => !!env[name]));
  for (const file of [join(cwd, '.env'), join(cwd, '.env.local'), join(home, '.config', 'grok', 'config.json'), join(home, '.config', 'devin', 'config.json'), join(home, '.ashlr', 'config.json')]) {
    const text = await read(file);
    if (!text) continue;
    for (const name of API_NAMES) if (new RegExp(`(?:^|[\\s"'])${name}["']?\\s*[:=]`, 'm').test(text)) keyNames.add(name);
    const parsed = object(json(text));
    if (parsed && (Object.hasOwn(parsed, 'apiKey') || Object.hasOwn(parsed, 'api_key'))) {
      if (file.includes('/grok/')) keyNames.add('XAI_API_KEY');
      if (file.includes('/devin/')) keyNames.add('DEVIN_API_KEY');
    }
  }
  add('api-keys', 'API key bindings', 'api-key', keyNames.size ? 'detected' : 'missing', [...keyNames], 'register', keyNames.size ? 'Import credentials in Phantom Secrets before use.' : null);

  const endpoints = await Promise.all(LOOPBACK.map(async url => ({ url, ok: await (options.probe ?? probeEcosystemLoopback)(url) })));
  for (const endpoint of endpoints) if (endpoint.ok) add(`local:${new URL(endpoint.url).port}`, `Local models on ${new URL(endpoint.url).port}`, 'local-model', 'detected', [], 'register', endpoint.url);

  const vaultBin = bins.get('phantom')?.[0];
  let vaultState: EcosystemCapability['state'] = vaultBin ? 'unknown' : 'missing';
  let secretNames: string[] = [];
  if (vaultBin) {
    const status = await run(vaultBin, ['status', '--json']);
    const metadata = object(json(status.stdout));
    if (status.code === 0 && metadata?.schema_version === 1 && metadata.initialized === true) {
      const result = await run(vaultBin, ['list', '--json']);
      const entries = json(result.stdout);
      // Warnings may mark a partial keychain-only inventory. It cannot prove emptiness.
      if (/vault locked|locked file vault|covers only the OS keychain/i.test(result.stderr)) vaultState = 'locked';
      else if (result.code === 0 && !result.stderr.trim() && Array.isArray(entries) && entries.every(entry => metadataName(object(entry)?.name))) {
        secretNames = namesOnly(entries.map(entry => object(entry)!.name));
        vaultState = entries.length ? 'populated' : 'empty';
      }
    }
  }
  add('vault', 'Phantom Secrets', 'vault', vaultState, secretNames, 'enable-mcp', vaultState === 'locked' ? 'Unlock the existing vault in a trusted terminal, then detect again: phantom list --json' : vaultState === 'unknown' ? 'Inspect project and vault access in a trusted terminal: phantom status --json' : null, !!vaultBin);

  const locusBin = bins.get('locus')?.[0];
  let bindingNames: string[] = [];
  let locusState: EcosystemCapability['state'] = locusBin ? 'unknown' : 'missing';
  if (locusBin) {
    const result = await run(locusBin, ['binding', 'list', '--json']);
    const bindings = json(result.stdout);
    if (result.code === 0 && Array.isArray(bindings) && bindings.every(binding => metadataName(object(binding)?.alias))) {
      bindingNames = namesOnly(bindings.map(binding => object(binding)!.alias));
      locusState = 'detected';
    }
  }
  add('locus', 'Locus identity bindings', 'locus', locusState, bindingNames, 'enable-mcp', null, !!locusBin);

  const terms: string[] = [];
  for (const path of [join(home, '.lexicon.yaml'), join(home, '.config', 'lexicon', 'lexicon.yaml'), join(cwd, '.lexicon.yaml')]) {
    const text = await read(path);
    if (!text) continue;
    try {
      const vocabulary = object(parseYaml(text));
      if (Array.isArray(vocabulary?.terms)) for (const term of vocabulary.terms) if (metadataName(object(term)?.canonical)) terms.push(object(term)!.canonical as string);
    } catch { /* unsupported vocabulary remains unreported */ }
  }
  add('lexicon', 'Lexicon project vocabulary', 'lexicon', bins.has('lexicon') ? 'detected' : 'missing', terms, 'seed');

  const mcpNames: string[] = [];
  for (const path of [join(cwd, '.mcp.json'), join(home, '.claude.json'), join(home, '.cursor', 'mcp.json'), join(home, '.ashlr', 'settings.json')]) {
    const text = await read(path);
    const servers = text ? object(object(json(text))?.mcpServers) : null;
    if (servers) mcpNames.push(...Object.keys(servers));
  }
  // Never read the default Codex home or auth files. Only lane-owned config metadata.
  if (env.CODEX_HOME && resolve(env.CODEX_HOME).startsWith(join(home, '.ashlr-runs') + '/')) {
    try {
      const path = join(env.CODEX_HOME, 'config.toml');
      await safePath(path, home);
      const text = await read(path);
      if (text) mcpNames.push(...Object.keys(object(parseToml(text).mcp_servers) ?? {}));
    } catch { /* refused or unknown lane config */ }
  }
  add('connected-mcps', 'Connected MCP servers', 'mcp', mcpNames.length ? 'detected' : 'missing', mcpNames, 'register');
  for (const [id, binary] of [['github', 'gh'], ['supabase', 'supabase'], ['vercel', 'vercel']] as const) {
    add(`service:${id}`, id, 'service', bins.has(binary) || mcpNames.includes(id) ? 'detected' : 'missing', bins.has(binary) ? [binary] : []);
  }
  add('stack', 'Stack service MCP', 'mcp', bins.has('stack') ? 'detected' : 'missing', [], 'enable-mcp');
  const plugin = bins.has('ashlr-mcp') || mcpNames.includes('ashlr') || mcpNames.includes('ashlr-plugin');
  add('plugin', 'Ashlr plugin', 'plugin', plugin ? 'detected' : 'missing', [], plugin ? 'enable-mcp' : 'install-plugin', null, plugin);
  const appRoots = options.applicationRoots ?? (options.home ? [join(home, 'Applications')] : [join(home, 'Applications'), '/Applications']);
  const installedApps = await Promise.all(appRoots.map(root => read(join(root, 'Ashlr MD.app', 'Contents', 'Info.plist'))));
  const md = bins.has('mdopen') || installedApps.some(text => text !== null);
  add('ashlr-md', 'Ashlr MD', 'markdown', md ? 'detected' : 'missing', [], md ? 'register' : 'install-markdown', md ? null : 'https://github.com/ashlrai/ashlr-md/releases/latest', md);
  for (const [id, label, present] of [['1password', '1Password', bins.has('op')], ['bitwarden', 'Bitwarden', bins.has('bw')], ['provider', 'Provider exports', keyNames.size > 0], ['grokbot', 'Grokbot vault', await read(join(home, '.grokbot', 'config.json')) !== null]] as const) {
    add(`import:${id}`, `Import from ${label}`, 'import', present ? 'detected' : 'missing', [], 'import-offer', 'Use Phantom Secrets import in a trusted terminal. Never paste an export into the wizard.', false);
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const planId = createHash('sha256').update(JSON.stringify({ home, cwd, rows, installations: [...bins].sort() })).digest('hex');
  return { schemaVersion: 1, phase: 'preview', planId, capabilities: rows };
}

/** Repository/org seeds come from local names, not a network lookup or a credential-bearing remote URL. */
export function ecosystemSeeds(cwd: string): string[] {
  return namesOnly([basename(cwd), basename(resolve(cwd, '..'))]);
}
