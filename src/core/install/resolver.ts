import { InstallError } from './storage.js';
/** Bounded, anonymous metadata resolution. Documentation is parsed as data, never executed. */
import { get } from 'node:https';
import { createHash } from 'node:crypto';
import { assertMetadata } from '../connectors/profile.js';
import { EXACT_VERSION, NPM_NAME, REPO_NAME, parseInstallManifest, safeRelativeFile, type InstallManifest } from './manifest.js';

export type MetadataReader = (url: string) => Promise<string | null>;
export interface ResolvedInstall { manifest: InstallManifest; entrypoint: string; source: string; evidence: string[] }
const HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com', 'registry.npmjs.org']);
const MAX_BYTES = 512 * 1024;

/** null means HTTP 404 only. Transport failures and invalid documents stop resolution. */
export const readInstallMetadata: MetadataReader = async value => {
  let url: URL;
  try { url = new URL(value); } catch { throw new InstallError('Invalid install metadata URL.'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash || url.port) throw new InstallError('Unsupported install metadata URL.');
  return new Promise((resolve, reject) => {
    const fail = () => reject(new InstallError('Install metadata request failed. Retry when the public source is available.'));
    const request = get(url, { agent: false, headers: { 'user-agent': 'phantom-install', accept: 'application/json, text/plain', 'accept-encoding': 'identity' } }, response => {
      if (response.statusCode === 404) { response.destroy(); resolve(null); return; }
      const length = response.headers['content-length'];
      if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') ||
        (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))) { response.destroy(); fail(); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { response.destroy(); fail(); } else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', fail); response.on('aborted', fail);
    });
    const timer = setTimeout(() => { request.destroy(); fail(); }, 15_000);
    request.on('error', fail); request.on('close', () => clearTimeout(timer));
  });
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function json(text: string): unknown {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new InstallError('Install metadata exceeds its size limit.');
  try { return JSON.parse(text); } catch { throw new InstallError('Install metadata is not valid JSON.'); }
}
function repository(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : object(value)?.url;
  if (typeof raw !== 'string') return null;
  const match = raw.match(/^(?:(?:git\+)?https:\/\/github\.com\/|git@github\.com:|github:)([A-Za-z0-9_-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  return match?.[1].toLowerCase() ?? null;
}
function bins(pkg: Record<string, unknown>): Record<string, string> {
  const raw = typeof pkg.bin === 'string' && typeof pkg.name === 'string'
    ? { [pkg.name.split('/').at(-1)!]: pkg.bin } : object(pkg.bin);
  if (!raw) throw new InstallError('The package does not declare a CLI executable.');
  const entries = Object.entries(raw);
  if (!entries.length || entries.some(([name, path]) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) || typeof path !== 'string' || !safeRelativeFile(path.replace(/^\.\//, '')))) throw new InstallError('The package declares unsupported executable metadata.');
  return raw as Record<string, string>;
}
function packageId(name: string): string {
  let id = name.split('/').at(-1)!.replace(/[^a-z0-9-]/g, '-');
  if (!/^[a-z]/.test(id) || ['constructor', 'prototype'].includes(id)) id = `tool-${id}`;
  return id.length <= 64 ? id : `${id.slice(0, 51)}-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
}
function nodeEntrypoint(path: string): string {
  const normalized = path.replace(/^\.\//, '');
  if (!safeRelativeFile(normalized) || !/\.(?:js|cjs|mjs)$/.test(normalized)) throw new InstallError('Version 1 requires a published Node.js executable; native and bootstrap installers are unsupported.');
  return normalized;
}

export async function resolveInstall(input: string, read: MetadataReader = readInstallMetadata): Promise<ResolvedInstall> {
  try { assertMetadata(input); } catch { throw new InstallError('Install locator contains secret-shaped data. Use a public package or repository name.'); }
  if (input !== input.trim() || input.length > 256 || [...input].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) throw new InstallError('Use a package name or public GitHub repository.');
  const evidence: string[] = [];
  const getText = async (url: string): Promise<string | null> => {
    const text = await read(url);
    if (text !== null) {
      if (Buffer.byteLength(text) > MAX_BYTES) throw new InstallError('Install metadata exceeds its size limit.');
      evidence.push(url);
    }
    return text;
  };
  const registry = async (name: string, version = 'latest', expectedRepo?: string): Promise<{ pkg: Record<string, unknown>; source: string }> => {
    if (!NPM_NAME.test(name) || name.length > 214 || (version !== 'latest' && !EXACT_VERSION.test(version))) throw new InstallError('Unsupported npm package or version.');
    const source = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
    const text = await getText(source);
    if (text === null) throw new InstallError('The requested npm package version is not published.');
    const pkg = object(json(text));
    if (!pkg || pkg.name !== name || typeof pkg.version !== 'string' || !EXACT_VERSION.test(pkg.version) || (version !== 'latest' && pkg.version !== version)) throw new InstallError('The npm registry returned inconsistent package metadata.');
    if (expectedRepo && repository(pkg.repository) !== expectedRepo.toLowerCase()) throw new InstallError('The npm package is not associated with the requested repository.');
    if (version === 'latest') return registry(name, pkg.version, expectedRepo);
    return { pkg, source };
  };
  const explicit = async (value: unknown, source: string): Promise<ResolvedInstall> => {
    const manifest = parseInstallManifest(value);
    let entrypoint = manifest.install.bin;
    if (manifest.install.kind === 'npm') {
      const { pkg } = await registry(manifest.install.package, manifest.install.version);
      const provided = bins(pkg);
      if (!Object.hasOwn(provided, manifest.install.bin)) throw new InstallError('The selected executable is not provided by this npm version.');
      entrypoint = nodeEntrypoint(provided[manifest.install.bin]);
    }
    return { manifest, entrypoint, source, evidence };
  };
  const fromPackage = async (name: string, version: string | undefined, expectedRepo?: string): Promise<ResolvedInstall> => {
    const { pkg, source } = await registry(name, version, expectedRepo);
    const provided = bins(pkg);
    const names = Object.keys(provided);
    const mcp = names.filter(name => name.endsWith('-mcp'));
    const bin = mcp.length === 1 ? mcp[0] : names.length === 1 ? names[0] : undefined;
    if (!bin) throw new InstallError('Multiple executable candidates require an explicit install manifest.');
    const manifest = parseInstallManifest({ version: 1, id: packageId(name), install: { kind: 'npm', package: name, version: pkg.version, bin }, ...(mcp.length === 1 ? { mcp: { args: [] } } : {}) });
    return { manifest, entrypoint: nodeEntrypoint(provided[bin]), source, evidence };
  };

  let repo: string | null = null;
  if (input === 'lexicon' || input === 'locus') repo = `ashlrai/${input}`;
  else if (input.startsWith('https://')) {
    try {
      const url = new URL(input);
      if (url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) throw new InstallError();
      repo = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '');
      if (!REPO_NAME.test(repo)) throw new InstallError();
    } catch { throw new InstallError('Use a public GitHub repository URL without credentials, query or fragment.'); }
  } else if (!input.startsWith('@') && REPO_NAME.test(input)) repo = input.replace(/\.git$/, '');
  else if (NPM_NAME.test(input)) return fromPackage(input, undefined);
  else throw new InstallError('Use an npm package name, owner/repo, or public GitHub repository URL.');

  const commitText = await getText(`https://api.github.com/repos/${repo}/commits/HEAD`);
  const sha = commitText === null ? undefined : object(json(commitText))?.sha;
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new InstallError('The repository HEAD could not be resolved.');
  const base = `https://raw.githubusercontent.com/${repo}/${sha}`;
  const manifestSource = `${base}/phantom.install.json`;
  const manifestText = await getText(manifestSource);
  if (manifestText !== null) return explicit(json(manifestText), manifestSource);
  for (const file of ['llms.txt', 'AGENTS.md']) {
    const source = `${base}/${file}`;
    const text = await getText(source);
    if (text === null) continue;
    const fences = [...text.matchAll(/^```phantom-install\s*\r?\n([\s\S]*?)^```\s*$/gm)];
    if (fences.length > 1 || (text.includes('```phantom-install') && fences.length !== 1)) throw new InstallError('Documentation contains an ambiguous install manifest.');
    if (fences.length === 1) return explicit(json(fences[0][1]), source);
    const hints = [...text.matchAll(/^\s*(?:\$ )?npm install -g ((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([^\s]+))?\s*$/gm)];
    if (hints.length === 1) {
      const result = await fromPackage(hints[0][1], hints[0][2], repo);
      return { ...result, source };
    }
  }
  const packageSource = `${base}/package.json`;
  const packageText = await getText(packageSource);
  const pkg = packageText === null ? null : object(json(packageText));
  if (!pkg || typeof pkg.name !== 'string' || typeof pkg.version !== 'string') throw new InstallError('No supported install metadata was found. Add phantom.install.json to the repository.');
  if (repository(pkg.repository) !== repo.toLowerCase()) throw new InstallError('Repository package metadata does not identify the requested repository.');
  const result = await fromPackage(pkg.name, pkg.version, repo);
  return { ...result, source: packageSource };
}
