/** Metadata only. No connector execution, credential resolution, or client writes. */
import { mkdir, readFile, writeFile, rename, rm, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import { scrubSecrets } from '../util/scrub.js';

export class ConnectorError extends Error {}
const fail = (message: string): never => { throw new ConnectorError(message); };
const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/);
const words = z.array(name).max(128).default([]);
const entry = z.object({
  id: name,
  kind: z.enum(['mcp-stdio', 'mcp-http', 'cli', 'plugin']),
  command: z.string().min(1).max(1024).optional(),
  args: z.array(z.string().max(2048)).max(128).default([]),
  url: z.string().max(2048).optional(),
  scopes: words, tools: words, lanes: words,
  credentials: z.array(z.object({ binding: name, name }).strict()).max(128).default([]),
}).strict();
const schema = z.object({ version: z.literal(1), connectors: z.array(entry).max(256) }).strict();
export type Connector = z.infer<typeof entry>;
export type ConnectorProfile = z.infer<typeof schema>;

/** Also covers provider shapes in the pinned publish gate absent from the shared scrubber. */
export function assertMetadata(text: string): void {
  if (scrubSecrets(text) !== text || /(?:xapp-\d+-[A-Za-z0-9-]{10,}|xox[abposr]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|sk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|shp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/.test(text)) {
    fail('Secret-shaped metadata refused. Import credentials with phantom import in a trusted terminal; use only vault names in credentials.');
  }
}
export function validateProfile(value: unknown): ConnectorProfile {
  // Inspect before schema errors: diagnostics must never echo rejected values.
  assertMetadata(JSON.stringify(value));
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail('Invalid connector profile. Use version = 1 and documented connector fields; run phm connectors --help.');
  const profile = parsed.data!;
  const ids = new Set<string>();
  for (const c of profile.connectors) {
    if (ids.has(c.id)) fail('Duplicate connector id. Remove the duplicate entry before retrying.');
    ids.add(c.id);
    if (c.kind === 'mcp-http') {
      if (!c.url || c.command || c.args.length) fail('mcp-http requires url and forbids command/args.');
    } else if (!c.command || c.url) fail('stdio, cli and plugin entries require command and forbid url.');
    if (c.command && !/^[A-Za-z0-9_./@+ -]+$/.test(c.command)) fail('Use a plain executable path in command; put arguments in args.');
    if (c.args.some(a => /(?:bearer|authorization|password|token|secret|api[-_]?key|credential)(?:[=: ]|$)/i.test(a))) fail('Credential arguments refused. Use credential references instead.');
    if (c.url) {
      let u: URL;
      try { u = new URL(c.url); } catch { fail('Invalid connector URL. Use an HTTPS endpoint without credentials, query or fragment.'); }
      if (u!.username || u!.password || u!.search || u!.hash || !(u!.protocol === 'https:' || (u!.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u!.hostname)))) {
        fail('Use HTTPS (or loopback HTTP) without URL credentials, query or fragment; store credentials as vault references.');
      }
    }
    if (new Set(c.credentials.map(r => r.binding)).size !== c.credentials.length) fail('Credential bindings must be unique per connector.');
  }
  return profile;
}
async function safePath(path: string, home: string): Promise<void> {
  const absolute = resolve(path);
  const root = resolve(home);
  const forbidden = (p: string): boolean => p.split(sep).some(part => part.toLowerCase() === '.codex');
  if (forbidden(absolute)) fail('Default Codex home is forbidden. Use a lane CODEX_HOME under ~/.ashlr-runs.');
  // System temp roots can be aliases on macOS; only client-owned descendants
  // must be regular paths. Resolve the supplied home before inspecting children.
  let current = await realpath(root);
  if (forbidden(current)) fail('Default Codex home is forbidden. Use a lane CODEX_HOME under ~/.ashlr-runs.');
  const lexicalRoot = absolute.startsWith(root + sep) ? root : current;
  if (!absolute.startsWith(lexicalRoot + sep)) fail('External config path refused. Use a lane CODEX_HOME under ~/.ashlr-runs.');
  for (const part of absolute.slice(lexicalRoot.length + 1).split(sep)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) fail('Symlinked connector/config paths are refused. Use regular files and directories.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  }
}
export const profilePath = (home = homedir()): string => join(home, '.phantom', 'connectors', 'profile.toml');
export function encodeProfile(profile: ConnectorProfile): string {
  const text = stringify(validateProfile(profile));
  assertMetadata(text);
  return text;
}
export async function readProfile(home = homedir()): Promise<ConnectorProfile> {
  await safePath(profilePath(home), home);
  let text: string;
  try { text = await readFile(profilePath(home), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, connectors: [] }; fail('Cannot read connector profile. Check file permissions.'); }
  assertMetadata(text!);
  let data: unknown;
  try { data = parse(text!); } catch { fail('Invalid profile TOML. Fix syntax in ~/.phantom/connectors/profile.toml.'); }
  return validateProfile(data);
}
/** Exclusive directory lease prevents lost updates; atomic replacement prevents partial profiles. */
export async function updateProfile(change: (p: ConnectorProfile) => ConnectorProfile, home = homedir()): Promise<ConnectorProfile> {
  const path = profilePath(home);
  const dir = join(home, '.phantom', 'connectors');
  await safePath(path, home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, '.profile-lock');
  try { await mkdir(lock); } catch { fail('Profile is locked. Retry; after an interrupted writer, remove ~/.phantom/connectors/.profile-lock.'); }
  const tmp = join(dir, `.profile-${randomUUID()}.tmp`);
  try {
    const profile = validateProfile(change(await readProfile(home)));
    await writeFile(tmp, encodeProfile(profile), { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
    return profile;
  } finally { await rm(tmp, { force: true }); await rm(lock, { recursive: true, force: true }); }
}

export interface ImportReport { imported: string[]; skipped: Array<{ source: string; reason: string }>; }
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** Fixed paths only. Codex is opt-in through a lane-owned CODEX_HOME under ~/.ashlr-runs. */
export async function importClients(home = homedir(), codexHome = process.env.CODEX_HOME): Promise<ImportReport> {
  const report: ImportReport = { imported: [], skipped: [] };
  const sources = [{ label: 'claude', path: join(home, '.claude.json'), toml: false }, { label: 'cursor', path: join(home, '.cursor', 'mcp.json'), toml: false }];
  if (codexHome) {
    // Resolve physical paths before opening anything. In particular, never open ~/.codex.
    try {
      await safePath(join(home, '.ashlr-runs'), home);
      await safePath(join(resolve(codexHome), 'config.toml'), home);
      const root = await realpath(join(home, '.ashlr-runs'));
      const lane = await realpath(resolve(codexHome));
      const file = join(lane, 'config.toml');
      if (!lane.startsWith(root + sep) || (await lstat(file)).isSymbolicLink() || !(await realpath(file)).startsWith(root + sep)) throw new Error();
      sources.push({ label: 'codex-lane', path: file, toml: true });
    } catch { report.skipped.push({ source: 'codex-lane', reason: 'Skipped: set CODEX_HOME to an existing lane directory under ~/.ashlr-runs with a regular config.toml.' }); }
  } else report.skipped.push({ source: 'codex-lane', reason: 'Skipped: no lane CODEX_HOME; ~/.codex is never read.' });
  const candidates: Connector[] = [];
  for (const source of sources) {
    let data: Record<string, unknown>;
    try {
      await safePath(source.path, home);
      const info = await lstat(source.path);
      if (!info.isFile() || info.size > 2_000_000) throw new Error();
      const text = await readFile(source.path, 'utf8');
      if (text.length > 2_000_000) throw new Error();
      data = record(source.toml ? parse(text) : JSON.parse(text));
    } catch { report.skipped.push({ source: source.label, reason: 'Client config absent, unreadable or invalid; configure the client and retry.' }); continue; }
    for (const [id, raw] of Object.entries(record(data[source.toml ? 'mcp_servers' : 'mcpServers']))) {
      const c = record(raw);
      // Unknown fields, args, env and headers are deliberately never copied.
      // A credential-bearing connector needs a value-blind Secrets migration adapter.
      if (Object.keys(c).some(key => !['type', 'url', 'command', 'args', 'disabled', 'enabled', 'timeout'].includes(key))) {
        report.skipped.push({ source: source.label, reason: 'Credential-bearing entry withheld. Use phantom import in its trusted terminal, replace inline credentials with references, then add metadata with phm connectors add.' }); continue;
      }
      try {
        const candidate = validateProfile({ version: 1, connectors: [{ id, kind: c.url ? 'mcp-http' : 'mcp-stdio', ...(c.url ? { url: c.url } : { command: c.command }), scopes: [], tools: [], lanes: [] }] }).connectors[0]!;
        if (Array.isArray(c.args) && c.args.length) {
          report.skipped.push({ source: source.label, reason: 'Command arguments require review. Add the executable and safe arguments explicitly with phm connectors add.' }); continue;
        }
        if (c.disabled === true || c.enabled === false) {
          report.skipped.push({ source: source.label, reason: 'Disabled client entry retained in client only. Add metadata explicitly to include it.' }); continue;
        }
        candidates.push(candidate);
      } catch { report.skipped.push({ source: source.label, reason: 'Unsafe or unsupported metadata withheld. Add a plain executable or credential-free HTTPS URL with phm connectors add.' }); }
    }
  }
  await updateProfile(p => {
    for (const c of candidates) {
      if (p.connectors.some(e => e.id === c.id)) { report.skipped.push({ source: 'profile', reason: 'Existing connector id retained; use show/remove before replacing it.' }); continue; }
      p.connectors.push(c); report.imported.push(c.id);
    }
    return p;
  }, home);
  return report;
}
