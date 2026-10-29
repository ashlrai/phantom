/** Standalone advertised model metadata. No routing, spending or availability authority. */
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assurePrivateStoragePath } from './util/private-storage.js';
import { writePrivateFileAtomically } from './util/private-file-write.js';

export const MODELCAPS_MAX_BYTES = 2 * 1024 * 1024;
export const MODELCAPS_TIMEOUT_MS = 10_000;
const MAX_MODELS = 10_000;
const CAPABILITIES = ['tools', 'vision', 'reasoning'] as const;

export interface ModelCaps {
  id: string;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  capabilities: Record<typeof CAPABILITIES[number], boolean | null>;
}

export interface ModelCapsCache {
  schema: 'modelcaps.v1';
  provider: string;
  observedAt: string;
  expiresAt: string;
  source: '/v1/models';
  models: ModelCaps[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveTokens(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('modelcaps: invalid token limit');
  }
  return value;
}

/** Parse OpenAI list envelopes and explicit optional metadata, never model-name guesses. */
export function parseModelsResponse(body: unknown): ModelCaps[] {
  if (!record(body) || !Array.isArray(body.data) || body.data.length > MAX_MODELS ||
    body.object !== undefined && body.object !== 'list' ||
    body.has_more !== undefined && body.has_more !== false ||
    body.next_page != null || body.next != null || body.error !== undefined) {
    throw new Error('modelcaps: invalid or incomplete model list');
  }
  const ids = new Set<string>();
  const models: ModelCaps[] = [];
  for (const row of body.data) {
    if (!record(row) || typeof row.id !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/.test(row.id) || ids.has(row.id) ||
      row.object !== undefined && row.object !== 'model') {
      throw new Error('modelcaps: invalid or duplicate model');
    }
    ids.add(row.id);
    const capabilities: ModelCaps['capabilities'] = { tools: null, vision: null, reasoning: null };
    const advertised = row.capabilities;
    if (advertised != null) {
      if (Array.isArray(advertised)) {
        if (advertised.length > 64 || advertised.some(v => typeof v !== 'string' || v.length > 64)) {
          throw new Error('modelcaps: invalid capabilities');
        }
        // Missing tags remain unknown: absence is not evidence of unsupported functionality.
        for (const key of CAPABILITIES) if (advertised.includes(key)) capabilities[key] = true;
      } else if (record(advertised)) {
        for (const key of CAPABILITIES) {
          const value = advertised[key];
          if (value !== undefined && value !== null && typeof value !== 'boolean') {
            throw new Error('modelcaps: invalid capability');
          }
          capabilities[key] = value ?? null;
        }
      } else throw new Error('modelcaps: invalid capabilities');
    }
    models.push({ id: row.id, contextWindowTokens: positiveTokens(row.context_length),
      maxOutputTokens: positiveTokens(row.max_output_tokens), capabilities });
  }
  return models.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Only the Secrets-injected loopback proxy and placeholder may carry this request. */
export function modelcapsProxyUrl(base: string | undefined, credential: string | undefined): URL {
  if (!base || !credential || !/^phm_[a-zA-Z0-9_-]+$/.test(credential)) {
    throw new Error('modelcaps: Phantom Secrets proxy required');
  }
  let url: URL;
  try { url = new URL(base); } catch { throw new Error('modelcaps: invalid proxy URL'); }
  if (!['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash) {
    throw new Error('modelcaps: loopback proxy required');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1/models') ? path : path.endsWith('/v1') ? `${path}/models` : `${path}/v1/models`;
  return url;
}

async function probeModels(url: URL, credential: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<ModelCaps[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('modelcaps: probe timed out')); }, timeoutMs);
    });
    const request = async (): Promise<ModelCaps[]> => {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error',
        headers: { Accept: 'application/json', Authorization: `Bearer ${credential}` }, signal: controller.signal });
      if (response.status !== 200 || !response.body ||
        /\brel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|'[^']*\bnext\b[^']*'|next\b)/i.test(response.headers.get('link') ?? '')) {
        void response.body?.cancel().catch(() => {});
        throw new Error('modelcaps: model listing failed');
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MODELCAPS_MAX_BYTES)) {
        void response.body.cancel().catch(() => {});
        throw new Error('modelcaps: response too large');
      }
      if (controller.signal.aborted) {
        void response.body.cancel().catch(() => {});
        controller.signal.throwIfAborted();
      }
      reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await reader.read();
          controller.signal.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MODELCAPS_MAX_BYTES) throw new Error('modelcaps: response too large');
          chunks.push(part.value);
        }
        return parseModelsResponse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      } finally {
        void reader.cancel().catch(() => {});
      }
    };
    return await Promise.race([request(), deadline]);
  } catch {
    // Transport errors and JSON errors can include credential-bearing URLs or raw bodies.
    throw new Error('modelcaps: probe failed');
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

function privateDirectory(path: string): void {
  // Preflight before recursive mkdir, which otherwise follows symlink ancestors.
  // Use canonical paths (including on macOS, where /tmp and /var are aliases).
  for (let cursor = path; ; cursor = dirname(cursor)) {
    try {
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('modelcaps: unsafe cache directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(cursor) === cursor) break;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
    typeof process.getuid === 'function' && stat.uid !== process.getuid() ||
    process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('modelcaps: cache directory must be private');
  if (!assurePrivateStoragePath(path, 'directory', 'inspect-existing', { anchorPath: path }).ok) {
    throw new Error('modelcaps: unsafe cache directory');
  }
}

export interface ModelCapsProbeOptions {
  provider: string;
  output: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

/** All-or-nothing refresh. Failures before publication leave the prior cache intact. */
export async function refreshModelCaps(options: ModelCapsProbeOptions): Promise<ModelCapsCache> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.provider) || !isAbsolute(options.output)) {
    throw new Error('modelcaps: invalid provider or output path');
  }
  const timeoutMs = options.timeoutMs ?? MODELCAPS_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('modelcaps: invalid timeout');
  const env = options.env ?? process.env;
  const url = modelcapsProxyUrl(env.OPENAI_BASE_URL, env.OPENAI_API_KEY);
  const models = await probeModels(url, env.OPENAI_API_KEY!, options.fetchImpl ?? fetch, timeoutMs);
  const now = (options.now ?? (() => new Date()))();
  const cache: ModelCapsCache = { schema: 'modelcaps.v1', provider: options.provider,
    observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    source: '/v1/models', models };
  const parent = dirname(options.output);
  privateDirectory(parent);
  try {
    const stat = lstatSync(options.output);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('modelcaps: unsafe cache file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writePrivateFileAtomically(join(parent, `.modelcaps-${randomUUID()}.tmp`), options.output,
    `${JSON.stringify(cache, null, 2)}\n`, { anchorPath: parent, label: 'modelcaps cache' });
  return cache;
}

export function modelcapsArguments(args: readonly string[]): { provider: string; output: string } {
  let provider: string | undefined;
  let output: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!['--provider', '--output'].includes(key) || seen.has(key) || !value || value.startsWith('--')) {
      throw new Error('modelcaps: expected --provider ID [--output ABS_PATH]');
    }
    seen.add(key);
    if (key === '--provider') provider = value;
    else output = value;
  }
  if (!provider) throw new Error('modelcaps: --provider is required');
  return { provider, output: output ?? join(homedir(), '.ashlr', 'modelcaps', `${provider}.json`) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await refreshModelCaps(modelcapsArguments(process.argv.slice(2)));
    process.stdout.write('modelcaps: cache refreshed\n');
  } catch {
    process.stderr.write('modelcaps: probe failed\n');
    process.exitCode = 1;
  }
}
