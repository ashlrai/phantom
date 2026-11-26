import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MAX_BRAND_BYTES = 512 * 1024;
export const BRAND_ASSET_ID = /^sha256:[a-f0-9]{64}$/;
export const BRAND_MARKS = ['p', 'ghost', 'upload'] as const;
export type BrandMark = (typeof BRAND_MARKS)[number];

type Image = { bytes: Buffer; contentType: 'image/svg+xml' | 'image/png' | 'image/webp' };

export class BrandUploadError extends Error {}

const svgNamespace = 'http://www.w3.org/2000/svg';
const tags = new Set('svg g defs symbol use path rect circle ellipse line polyline polygon title desc text tspan linearGradient radialGradient stop pattern clipPath mask'.split(' '));
const attributes = new Set('id viewBox width height x y x1 y1 x2 y2 cx cy r rx ry fx fy fr dx dy d points transform preserveAspectRatio gradientUnits gradientTransform spreadMethod patternUnits patternContentUnits patternTransform clipPathUnits maskUnits maskContentUnits opacity fill-opacity stroke-opacity stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset fill-rule clip-rule vector-effect stop-opacity font-size font-weight text-anchor dominant-baseline offset'.split(' '));
const paints = new Set(['fill', 'stroke', 'color', 'stop-color']);
const localId = '#[a-zA-Z_][a-zA-Z0-9_.:-]*';
const localHref = new RegExp(`^${localId}$`);
const localUrl = new RegExp(`^url\\(\\s*${localId}\\s*\\)$`);
const plainPaint = /^(?:[a-zA-Z]+|#[a-fA-F0-9]{3,8}|(?:rgba?|hsla?)\([0-9.,% /+-]+\))$/;
const textEscapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as const;

function escapeXml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => textEscapes[ch as keyof typeof textEscapes]);
}

function isXmlCharacter(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff)
    || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

function decodeXml(value: string): string {
  if (/&(?!#(?:[0-9]+|x[0-9a-fA-F]+);|(?:amp|lt|gt|quot|apos);)/.test(value)) invalidSvg();
  return value.replace(/&(#(?:[0-9]+|x[0-9a-fA-F]+)|amp|lt|gt|quot|apos);/g, (_ref, entity: string) => {
    if (!entity.startsWith('#')) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity]!;
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!isXmlCharacter(code)) invalidSvg();
    return String.fromCodePoint(code);
  });
}

function invalidSvg(): never {
  throw new BrandUploadError('Expected a well-formed UTF-8 SVG without a DOCTYPE or processing instructions.');
}

function safeAttribute(key: string, value: string): boolean {
  if (key === 'href' || key === 'xlink:href') return localHref.test(value);
  if (key === 'clip-path' || key === 'mask') return localUrl.test(value);
  if (paints.has(key)) return plainPaint.test(value) || localUrl.test(value);
  return attributes.has(key);
}

function sanitizeSvg(bytes: Buffer): Buffer {
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return invalidSvg(); }
  for (const ch of xml) if (!isXmlCharacter(ch.codePointAt(0)!)) invalidSvg();
  xml = xml.replace(/^<\?xml\s+[^?]*\?>/, '');
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/[A-Za-z_][\w:.-]*\s*>|<[A-Za-z_][\w:.-]*(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/gy;
  const attrs = /\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const stack: { tag: string; keep: boolean }[] = [];
  const output: string[] = [];
  let root = false;
  while (tokens.lastIndex < xml.length) {
    const match = tokens.exec(xml);
    if (!match) invalidSvg();
    const token = match[0];
    const parent = stack.at(-1);
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('<![CDATA[') || !token.startsWith('<')) {
      const value = token.startsWith('<') ? token.slice(9, -3) : decodeXml(token);
      if (!parent && (token.startsWith('<') || value.trim())) invalidSvg();
      if (parent?.keep) output.push(escapeXml(value));
      continue;
    }
    if (token.startsWith('</')) {
      const tag = token.slice(2, -1).trim();
      if (!parent || tag !== parent.tag) invalidSvg();
      stack.pop();
      if (parent.keep) output.push(`</${tag}>`);
      continue;
    }
    const tag = /^<([\w:.-]+)/.exec(token)![1]!;
    if (!parent) {
      if (root || tag !== 'svg') invalidSvg();
      root = true;
    }
    const keep = (parent?.keep ?? true) && tags.has(tag);
    const selfClosing = token.endsWith('/>');
    if (keep) {
      const safe = new Map<string, string>();
      if (!parent) safe.set('xmlns', svgNamespace);
      const seen = new Set<string>();
      for (const [, key, double, single] of token.slice(tag.length + 1).matchAll(attrs)) {
        if (key === undefined || seen.has(key)) invalidSvg();
        seen.add(key);
        const value = decodeXml(double ?? single ?? '').trim();
        if (safeAttribute(key, value)) {
          const name = key === 'xlink:href' ? 'href' : key;
          if (!safe.has(name) || key === 'href') safe.set(name, value);
        }
      }
      const serialized = [...safe].map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
      output.push(`<${tag}${serialized}${selfClosing ? '/>' : '>'}`);
    }
    if (!selfClosing) stack.push({ tag, keep });
  }
  if (!root || stack.length > 0) invalidSvg();
  return Buffer.from(output.join(''));
}

function checkedSize(size: number): void {
  if (size > MAX_BRAND_BYTES) throw new BrandUploadError('Brand images must be at most 512 KB.');
}

export function sanitizeBrandImage(bytes: Buffer): Image {
  checkedSize(bytes.length);
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
      && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) {
    return { contentType: 'image/png', bytes };
  }
  if (bytes.length >= 20 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8
      && ['VP8 ', 'VP8L', 'VP8X'].some((fourcc) => bytes.toString('latin1', 12, 16) === fourcc)
      && bytes.toString('latin1', 8, 12) === 'WEBP' && bytes.readUInt32LE(16) <= bytes.length - 20) {
    return { contentType: 'image/webp', bytes };
  }
  const sanitized = sanitizeSvg(bytes);
  checkedSize(sanitized.length);
  return { contentType: 'image/svg+xml', bytes: sanitized };
}

function assetDir(): string {
  return join(homedir(), '.ashlr', 'sidebar-marks');
}

async function readBounded(path: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) throw new BrandUploadError('Choose a regular image file.');
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(MAX_BRAND_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    checkedSize(length);
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

function assetId(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function assetPath(id: string): string {
  return join(assetDir(), id.slice('sha256:'.length));
}

export async function storeBrandImage(bytes: Buffer): Promise<string> {
  const image = sanitizeBrandImage(bytes);
  const id = assetId(image.bytes);
  const dir = assetDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, image.bytes, { mode: 0o600, flag: 'wx' });
    await rename(tmp, assetPath(id));
  } finally {
    await rm(tmp, { force: true });
  }
  return id;
}

export async function storeBrandImageFile(path: string): Promise<string> {
  let bytes: Buffer;
  try { bytes = await readBounded(path); }
  catch (error) {
    if (error instanceof BrandUploadError) throw error;
    throw new BrandUploadError('Could not read the brand image file.');
  }
  return storeBrandImage(bytes);
}

export async function readBrandImage(id: string): Promise<Image | null> {
  if (!BRAND_ASSET_ID.test(id)) return null;
  try {
    const bytes = await readBounded(assetPath(id));
    return assetId(bytes) === id ? sanitizeBrandImage(bytes) : null;
  } catch {
    return null;
  }
}
