/** M2 portable metadata. Digests attest bytes, never authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../authority/canonical-json.js';
import { assertMetadata, validateProfile } from '../connectors/profile.js';
import { validateAgentProfile } from '../agents/agent-profile.js';
import { normaliseAutomation } from '../automations/validate.js';
import { scrubPrivateText, scrubSecrets } from '../util/scrub.js';

export const bundleId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/).refine(value => !/\s/.test(value));
const partSchema = z.object({
  kind: z.enum(['profile', 'doctrine', 'prompt', 'memory', 'connector', 'automation']),
  path: z.string().min(1).max(160),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  content: z.string().max(256 * 1024),
}).strict();
export const bundleSchema = z.object({
  schema: z.literal('phantom.bundle.v1'), version: z.literal(1),
  kind: z.enum(['agent', 'tool']),
  principal: z.string().regex(/^own_[a-f0-9]{32}$/).refine(value => !/\s/.test(value)).nullable(),
  parts: z.array(partSchema).min(1).max(128),
}).strict();
export type Bundle = z.infer<typeof bundleSchema>;
export type BundlePart = z.infer<typeof partSchema>;

/** Shared canonical encoder, with RFC 8785's Unicode and JSON-domain restrictions. */
export function canonicalBundleJson(value: unknown): string {
  const visit = (v: unknown, depth: number): void => {
    if (depth > 40) throw new Error('Bundle nesting limit exceeded.');
    if (typeof v === 'string') {
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = v.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Lone surrogate refused.');
        } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error('Lone surrogate refused.');
      }
    } else if (v !== null && typeof v === 'object') {
      if (Object.getOwnPropertySymbols(v).length) throw new Error('Non-JSON key refused.');
      const descriptors = Object.getOwnPropertyDescriptors(v);
      if (Array.isArray(v)) {
        if (Object.getPrototypeOf(v) !== Array.prototype || Object.keys(descriptors).length !== v.length + 1) throw new Error('Non-JSON array refused.');
        for (let i = 0; i < v.length; i++) {
          const item = descriptors[String(i)];
          if (!item || !('value' in item)) throw new Error('Sparse or accessor array refused.');
          visit(item.value, depth + 1);
        }
      } else {
        if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('Non-JSON object refused.');
        for (const [key, item] of Object.entries(descriptors)) {
          if (!item.enumerable || !('value' in item)) throw new Error('Non-data JSON field refused.');
          visit(key, depth + 1); visit(item.value, depth + 1);
        }
      }
    } else if (v !== null && typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v))) throw new Error('Non-JSON value refused.');
  };
  visit(value, 0);
  return canonicalJson(value);
}
export function bundlePart(kind: BundlePart['kind'], path: string, content: string): BundlePart {
  return { kind, path, content, sha256: 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex') };
}

/** Explicit pinned-name denial is independent of destination confinement. */
export function assertBundleTarget(path: string): void {
  if (/[\p{Cc}\p{Cf}]/u.test(path)) throw new Error('Control characters in bundle target refused.');
  if (/(?:^|\/)(?:leader(?:[._-].*)?|wrappers?(?:[._-].*)?|dispatchd(?:[._-].*)?|scrub\.pl|publish\.sh|sandbox(?:[._-].*)?|pinned(?:[._-].*)?|launch-gate\.sh|install-gate\.py)(?:\/|$)/i.test(path)) throw new Error('Pinned bundle target refused.');
  if (path.startsWith('/') || path.includes('\\') || path.includes(':') || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Bundle path escapes profile directory.');
}

function assertPortable(value: unknown): void {
  if (typeof value === 'string') {
    assertMetadata(value);
    if (scrubPrivateText(value, { homes: [], emails: true }) !== value
      || /\b(?:eid|dev|device|kid)_[A-Za-z0-9_-]{8,}/.test(value)
      || /(?:^|[\s"'`=])(?:\/(?:Users|home|tmp|private|etc|var|opt|usr|Library|Applications|Volumes)(?:\/|\b)|[A-Za-z]:[\\/])/.test(value)) throw new Error('Private or local-path bundle content refused.');
  } else if (Array.isArray(value)) value.forEach(assertPortable);
  else if (value && typeof value === 'object') Object.values(value).forEach(assertPortable);
}

/** No resolution or socket is attempted. Hostnames are disabled data pending owner review. */
export function assertBundleConnector(value: unknown) {
  assertPortable(value);
  const entry = validateProfile({ version: 1, connectors: [value] }).connectors[0]!;
  if ([entry.id, ...entry.scopes, ...entry.tools, ...entry.lanes, ...entry.credentials.flatMap(c => [c.binding, c.name])].some(v => /\s/.test(v))) throw new Error('Invalid portable connector reference.');
  if (entry.command && (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(entry.command) || /\s/.test(entry.command))) throw new Error('Bundle connector requires a command name.');
  if (entry.args.some(arg => /(?:^|=)(?:\/|[A-Za-z]:[\\/]|\.{1,2}[\\/])/.test(arg))) throw new Error('Local connector argument paths refused.');
  if (entry.url) {
    const url = new URL(entry.url), host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:') throw new Error('Bundle connector requires HTTPS.');
    const ip = host.split('.').map(Number);
    const ipv4 = ip.length === 4 && ip.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
    const v6 = host.startsWith('[') ? host.slice(1, -1) : '';
    // Mapped IPv4 forms are refused conservatively, including public mapped addresses.
    if (['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'].includes(host) || host.endsWith('.localhost') || host.endsWith('.local')
      || ipv4 && (ip[0] === 0 || ip[0] === 127 || ip[0] === 10 || ip[0] === 169 && ip[1] === 254 || ip[0] === 172 && ip[1]! >= 16 && ip[1]! <= 31 || ip[0] === 192 && ip[1] === 168)
      || v6 && (v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('::ffff:'))) throw new Error('Private or loopback connector URL refused.');
  }
  return entry;
}
export function parseBundle(text: string): Bundle {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Bundle size limit exceeded.');
  // This is the existing shared scrub, unchanged, including public digest handling.
  if (scrubSecrets(text) !== text) throw new Error('Secret-shaped bundle refused.');
  assertMetadata(text);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid bundle JSON.'); }
  // Requiring canonical transport bytes also refuses duplicate keys and lossy numbers.
  if (canonicalBundleJson(value) !== text.trim()) throw new Error('Bundle requires canonical RFC 8785 JSON.');
  const parsed = bundleSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid bundle schema.');
  const bundle = parsed.data, paths = new Set<string>();
  for (const part of bundle.parts) {
    assertBundleTarget(part.path);
    const pattern: Record<BundlePart['kind'], RegExp> = { profile: /^profile\.json$/, doctrine: /^doctrine\.md$/, prompt: /^prompts\/[A-Za-z0-9_-]+\.md$/, memory: /^memory-seed\.md$/, connector: /^connectors\/[A-Za-z0-9_.-]+\.json$/, automation: /^automations\/[A-Za-z0-9_-]+\.json$/ };
    if (!pattern[part.kind].test(part.path) || paths.has(part.path.toLowerCase())) throw new Error('Invalid or duplicate bundle target.');
    paths.add(part.path.toLowerCase());
    if (bundlePart(part.kind, part.path, part.content).sha256 !== part.sha256) throw new Error('Bundle part digest mismatch.');
    assertPortable(part.content);
    if (['profile', 'connector', 'automation'].includes(part.kind)) assertPortable(JSON.parse(part.content));
    if (['profile', 'connector', 'automation'].includes(part.kind) && canonicalBundleJson(JSON.parse(part.content)) !== part.content) throw new Error('Bundle part requires canonical JSON.');
    if (part.kind === 'profile') {
      const profile = validateAgentProfile(JSON.parse(part.content));
      if (profile.doctrine !== 'doctrine.md' || !bundleId.safeParse(profile.id).success) throw new Error('Portable profile references required.');
    }
    if (part.kind === 'connector') assertBundleConnector(JSON.parse(part.content));
    if (part.kind === 'automation') normaliseAutomation(JSON.parse(part.content), { now: new Date(0), stored: true });
  }
  if (bundle.kind === 'agent' ? !paths.has('profile.json') || !paths.has('doctrine.md') : bundle.parts.length !== 1 || bundle.parts[0]!.kind !== 'connector') throw new Error('Bundle parts do not match its kind.');
  return bundle;
}
export function encodeBundle(bundle: Bundle): string {
  const text = canonicalBundleJson(bundle);
  parseBundle(text);
  return text;
}
export function inspectBundle(text: string) {
  const bundle = parseBundle(text);
  return { schema: bundle.schema, version: bundle.version, kind: bundle.kind, principal: bundle.principal,
    parts: bundle.parts.map(({ content: _content, ...part }) => part),
    connectors: bundle.parts.filter(p => p.kind === 'connector').map(p => { const c = assertBundleConnector(JSON.parse(p.content)); return { id: c.id, secretNames: c.credentials.map(r => r.name), enabled: false, bound: false }; }) };
}
