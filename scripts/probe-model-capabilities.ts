/* global process, Buffer, URL, fetch, AbortSignal */
/** Nightly metadata refresh. Credentials are confined to a Phantom proxy child. */
import { execFile } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  modelCapabilitiesPath, parseModelCapabilitiesResponse, readModelCapabilities,
  VERSE_CATALOG_MAX_BYTES, type ModelCapabilitiesCache,
} from '../src/core/verse/model-windows.js';

const script = fileURLToPath(import.meta.url);

/** Child emits only allowlisted metadata. Never forward child diagnostics. */
export function probeThroughPhantom(): Promise<unknown> {
  return new Promise((accept, reject) => {
    execFile('phantom', ['exec', '--', process.execPath, '--import', 'tsx', script, '--worker'],
      { timeout: 120_000, maxBuffer: VERSE_CATALOG_MAX_BYTES, encoding: 'utf8' }, (error, stdout) => {
        if (error) { reject(new Error('Model capability probe failed')); return; }
        try { accept(JSON.parse(stdout)); } catch { reject(new Error('Invalid model capability probe')); }
      });
  });
}

export async function refreshModelCapabilities(options: {
  path?: string; now?: number; force?: boolean; probe?: () => Promise<unknown>;
} = {}): Promise<'fresh' | 'updated'> {
  const path = options.path ?? modelCapabilitiesPath();
  const now = options.now ?? Date.now();
  if (!options.force && readModelCapabilities(path, now)) return 'fresh';
  const raw = await (options.probe ?? probeThroughPhantom)();
  // Worker output uses the public wire shape and is validated again here.
  const models = parseModelCapabilitiesResponse(raw);
  if (!models) throw new Error('Invalid model capability response');
  const cache: ModelCapabilitiesCache = { schema: 1, provider: 'anthropic', fetchedAt: now, models };
  const serialized = JSON.stringify(cache) + '\n';
  if (Buffer.byteLength(serialized) > VERSE_CATALOG_MAX_BYTES) throw new Error('Model capability cache too large');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return 'updated';
}

/** Runs only within phantom exec. Raw keys are refused, including accidental inherited keys. */
export async function probeWorker(): Promise<void> {
  const credential = process.env['ANTHROPIC_API_KEY'];
  if (!credential || !/^phm_[A-Za-z0-9_-]+$/.test(credential)) throw new Error();
  const base = new URL(process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com');
  if (base.username || base.password || base.search || base.hash) throw new Error();
  const provider = base.origin === 'https://api.anthropic.com';
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname) && ['http:', 'https:'].includes(base.protocol);
  if (!provider && !loopback) throw new Error();
  const deadline = AbortSignal.timeout(90_000);
  const data: unknown[] = [];
  let after: string | null = null;
  const cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${base.pathname.replace(/\/$/, '')}/v1/models`, base);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after_id', after);
    const response = await fetch(url, { headers: { 'x-api-key': credential, 'anthropic-version': '2026-10-21' },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > VERSE_CATALOG_MAX_BYTES) throw new Error();
      chunks.push(chunk);
    }
    const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    const rows = parseModelCapabilitiesResponse(raw);
    if (!rows || typeof raw['has_more'] !== 'boolean') throw new Error();
    // Reconstruct only documented public fields before crossing the child boundary.
    data.push(...rows.map(row => ({ id: row.id, line: row.line, max_input_tokens: row.maxInputTokens, max_tokens: row.maxOutputTokens,
      capabilities: { thinking: { supported: row.thinking.supported, types: Object.fromEntries(
        ['adaptive', 'enabled', 'disabled', 'between_tools'].map(key => [key, { supported: row.thinking[key as keyof typeof row.thinking] }])) },
      server_tools: { supported: row.serverTools.supported, web_search: { supported: row.serverTools.web_search },
        code_execution: { supported: row.serverTools.code_execution } } } })));
    if (!raw['has_more']) {
      const output = JSON.stringify({ data });
      if (!parseModelCapabilitiesResponse({ data }) || Buffer.byteLength(output) > VERSE_CATALOG_MAX_BYTES) throw new Error();
      process.stdout.write(output);
      return;
    }
    if (typeof raw['last_id'] !== 'string' || raw['last_id'] !== rows.at(-1)?.id || cursors.has(raw['last_id'])) throw new Error();
    after = raw['last_id'];
    cursors.add(after);
  }
  throw new Error();
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const action = process.argv[2] === '--worker' ? probeWorker() : refreshModelCapabilities({ force: process.argv.includes('--force') });
  action.catch(() => { process.stderr.write('Model capability refresh failed; static fallback remains available.\n'); process.exitCode = 1; });
}
