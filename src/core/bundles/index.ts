/** Portable copies use the existing profile tree; nothing here enables a tool or automation. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { validateAgentProfile } from '../agents/agent-profile.js';
import { assertMetadata, name as connectorName, profilePath, validateProfile } from '../connectors/profile.js';
import { scrubPrivateText } from '../util/scrub.js';
import { assertBundleConnector, assertBundleTarget, bundleId, bundlePart, canonicalBundleJson, encodeBundle, inspectBundle, parseBundle, type Bundle, type BundlePart } from './schema.js';
export { encodeBundle, inspectBundle, parseBundle } from './schema.js';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const limit = 4 * 1024 * 1024;
/** Check before any read, then again after realpath. Provider stores are never export sources. */
export function assertExportSource(path: string): void {
  if (/[\p{Cc}\p{Cf}]/u.test(path)) throw new Error('Control characters in bundle source refused.');
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  if (/\/(?:\.config\/(?:gh|gcloud|claude|codex|opencode|grok|devin)|library\/(?:keychains|application support\/(?:code|cursor|google|firefox|chromium|claude|codex|chatgpt|grok|devin|openai|anthropic))|appdata\/(?:local|roaming)\/(?:claude|codex|chatgpt|cursor|google|microsoft\/(?:vault|credentials)))(?:\/|$)/.test(normalized)
    || normalized.split('/').some(p => /^\.codex/.test(p) || /^\.env/.test(p)
    || /^\.(?:claude|cursor|gemini|grok|devin|opencode|aider|aws|azure|ssh|gnupg|docker|npmrc|netrc|git-credentials|mozilla)(?:$|[.-])/.test(p)
    || /^(?:auth|credentials?|sessions?|transcripts?|keychains?|local storage)(?:$|[\s._-])/.test(p)
    || /(?:^|[._-])(?:tokens?|cookies?|credentials?|keychain)(?:$|[._-])/.test(p))) throw new Error('Protected export source refused.');
}
async function confined(home: string, path: string): Promise<string> {
  const root = await realpath(home), absolute = resolve(path);
  const rel = relative(absolute.startsWith(root + sep) ? root : resolve(home), absolute);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Path escapes profile root.');
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlinked bundle path refused.');
      const physical = await realpath(current);
      if (!physical.startsWith(root + sep)) throw new Error('Bundle path escapes profile root.');
    } catch (error) { if (!missing(error)) throw error; }
  }
  return current;
}
async function boundedRead(path: string, cap = limit): Promise<string> {
  assertExportSource(path);
  const before = await lstat(path);
  if (before.isSymbolicLink()) throw new Error('Symlinked bundle source refused.');
  if (!before.isFile() || before.nlink !== 1 || before.size > cap) throw new Error('Bundle source must be a bounded regular file.');
  const physical = await realpath(path);
  assertExportSource(physical);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > cap || info.dev !== before.dev || info.ino !== before.ino) throw new Error('Bundle source must be a stable bounded regular file.');
    const bytes = await file.readFile();
    if (bytes.length > cap) throw new Error('Bundle source exceeds size limit.');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Bundle source must be UTF-8.');
    assertMetadata(text);
    return text;
  } finally { await file.close(); }
}
export async function readBundleFile(path: string): Promise<string> { const text = await boundedRead(path); parseBundle(text); return text; }
async function exclusiveWrite(path: string, text: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
}
export async function writeBundleFile(path: string, bundle: Bundle): Promise<void> {
  assertExportSource(path);
  assertExportSource(await realpath(dirname(resolve(path))));
  await exclusiveWrite(path, encodeBundle(bundle));
}
export async function readExportPart(path: string, home: string): Promise<string> {
  assertExportSource(path);
  const physical = await confined(home, path);
  const text = await boundedRead(physical, 256 * 1024);
  if (scrubPrivateText(text, { homes: [home], emails: true }) !== text) throw new Error('Private bundle content refused.');
  return text;
}
const jsonPart = (kind: BundlePart['kind'], path: string, value: unknown) => bundlePart(kind, path, canonicalBundleJson(value));
export interface ExportBundleOptions { home?: string; principal?: string | null; includeMemory?: boolean }
export async function exportBundle(kind: 'agent' | 'tool', id: string, options: ExportBundleOptions = {}): Promise<Bundle> {
  if (!(kind === 'tool' ? connectorName : bundleId).safeParse(id).success || /\s/.test(id)) throw new Error('Invalid bundle source id.');
  const home = options.home ?? homedir(), parts: BundlePart[] = [];
  const connector = async (name: string) => {
    const entry = validateProfile(parse(await readExportPart(profilePath(home), home))).connectors.find(c => c.id === name);
    if (!entry) throw new Error('Connector profile not found.');
    return jsonPart('connector', `connectors/${entry.id}.json`, assertBundleConnector(entry));
  };
  if (kind === 'tool') parts.push(await connector(id));
  else {
    const dir = join(home, '.phantom', 'agents', id);
    let profileSource = join(home, '.phantom', 'agents', `${id}.toml`);
    try { await lstat(profileSource); } catch (error) { if (!missing(error)) throw error; profileSource = join(dir, 'profile.toml'); }
    const profile = validateAgentProfile(parse(await readExportPart(profileSource, home)));
    if (profile.id !== id) throw new Error('Agent profile id mismatch.');
    if (isAbsolute(profile.doctrine) || profile.doctrine.split(/[\\/]/).includes('..')) throw new Error('Unsafe doctrine source.');
    const doctrine = join(home, '.phantom', profile.doctrine);
    parts.push(jsonPart('profile', 'profile.json', { ...profile, doctrine: 'doctrine.md', policy: validateAgentProfile({ id, displayName: profile.displayName, doctrine: 'doctrine.md' }).policy }));
    parts.push(bundlePart('doctrine', 'doctrine.md', await readExportPart(doctrine, home)));
    for (const ref of profile.mcpServers) parts.push(await connector(ref));
    try {
      await confined(home, join(dir, 'connectors'));
      for (const name of (await readdir(join(dir, 'connectors'))).sort()) {
        const saved = JSON.parse(await readExportPart(join(dir, 'connectors', name), home)) as { entry: Record<string, unknown>; credentialReferences: unknown };
        parts.push(jsonPart('connector', `connectors/${name}`, assertBundleConnector({ ...saved.entry, credentials: saved.credentialReferences })));
      }
    } catch (error) { if (!missing(error)) throw error; }
    const assetDir = dirname(doctrine), promptDir = join(assetDir, 'prompts');
    try {
      await confined(home, promptDir);
      const names = await readdir(promptDir);
      if (names.length > 32) throw new Error('Too many bundle prompts.');
      for (const name of names.sort()) {
        if (!/^[A-Za-z0-9_-]+\.md$/.test(name)) throw new Error('Invalid prompt source.');
        parts.push(bundlePart('prompt', `prompts/${name}`, await readExportPart(join(promptDir, name), home)));
      }
    } catch (error) { if (!missing(error)) throw error; }
    if (options.includeMemory) parts.push(bundlePart('memory', 'memory-seed.md', await readExportPart(join(assetDir, 'memory-seed.md'), home)));
    // Bot manifests already name their automations. Never scan unrelated private memory or jobs.
    let automationIds: string[] = [];
    try {
      const bot = JSON.parse(await readExportPart(join(assetDir, 'bot.json'), home)) as { automations?: unknown };
      if (!Array.isArray(bot.automations) || bot.automations.some(a => typeof a !== 'string' || !/^au_[a-z0-9-]+$/.test(a))) throw new Error('Invalid bot automation references.');
      automationIds = bot.automations;
    } catch (error) { if (!missing(error)) throw error; }
    if (automationIds.length) {
      const stored = JSON.parse(await readExportPart(join(home, '.ashlr', 'automations', 'automations.json'), home)) as { automations: Array<{ id: string }> };
      for (const ref of automationIds) {
        const definition = stored.automations.find(a => a.id === ref);
        if (!definition) throw new Error('Referenced automation unavailable.');
        parts.push(jsonPart('automation', `automations/${ref}.json`, definition));
      }
    }
    try {
      await confined(home, join(dir, 'automations'));
      for (const name of (await readdir(join(dir, 'automations'))).sort()) parts.push(bundlePart('automation', `automations/${name}`, await readExportPart(join(dir, 'automations', name), home)));
    } catch (error) { if (!missing(error)) throw error; }
  }
  const bundle: Bundle = { schema: 'phantom.bundle.v1', version: 1, kind, principal: options.principal ?? null, parts };
  return parseBundle(encodeBundle(bundle));
}

export interface ImportBundleOptions { as: string; apply?: boolean; home?: string }
export async function importBundle(text: string, options: ImportBundleOptions) {
  if (!bundleId.safeParse(options.as).success) throw new Error('Invalid imported agent id.');
  const bundle = parseBundle(text), home = options.home ?? homedir(), id = options.as;
  assertExportSource(home);
  assertExportSource(await realpath(home));
  const root = join(home, '.phantom', 'agents'), dir = join(root, id);
  await confined(home, dir);
  // Refuse every existing destination, including immutable files/directories, before writing.
  for (const path of [dir, join(root, `${id}.toml`)]) {
    try { await lstat(path); throw new Error('Imported agent destination already exists.'); }
    catch (error) { if (!missing(error)) throw error; }
  }
  const writes: Array<{ path: string; content: string }> = [];
  for (const part of bundle.parts) {
    assertBundleTarget(part.path);
    if (part.kind === 'profile') {
      const source = validateAgentProfile(JSON.parse(part.content));
      const profile = validateAgentProfile({ ...source, id, version: 1, doctrine: `agents/${id}/doctrine.md`, tools: [], channels: [], mcpServers: [], policy: undefined });
      const { dailyCap: _dailyCap, ...policy } = profile.policy;
      writes.push({ path: 'profile.toml', content: stringify({ ...profile, policy }) });
    } else if (part.kind === 'connector') {
      const entry = assertBundleConnector(JSON.parse(part.content)), { credentials, ...metadata } = entry;
      writes.push({ path: part.path, content: canonicalBundleJson({ entry: { ...metadata, credentials: [] }, credentialReferences: credentials, enabled: false, bound: false, ownerEnableRequired: true }) });
    } else if (part.kind === 'automation') writes.push({ path: part.path, content: canonicalBundleJson({ ...JSON.parse(part.content), enabled: false, spendCapUsd: 0 }) });
    else writes.push({ path: part.path, content: part.content });
  }
  writes.push({ path: 'bundle-provenance.json', content: canonicalBundleJson({ schema: bundle.schema, principal: null, origin: bundle.principal, parts: bundle.parts.map(({ content: _content, ...part }) => part) }) });
  const plan = { ...inspectBundle(text), as: id, principal: null, origin: bundle.principal, dryRun: !options.apply, files: writes.map(w => w.path), draftsOnly: true, automationsEnabled: false };
  if (!options.apply) return plan;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await confined(home, dir);
  await mkdir(dir, { mode: 0o700 });
  try {
    // Profile becomes visible only after all inert parts have been saved successfully.
    for (const write of writes.sort((a, b) => Number(a.path === 'profile.toml') - Number(b.path === 'profile.toml'))) {
      const path = await confined(home, join(dir, write.path));
      if (!path.startsWith((await realpath(dir)) + sep)) throw new Error('Bundle write escaped profile directory.');
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await confined(home, path);
      await exclusiveWrite(path, write.content);
    }
    return plan;
  } catch (error) {
    // This call exclusively created dir and never replaces an existing profile.
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
