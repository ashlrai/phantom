import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = new URL('../docs/brand/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, directory));
type Asset = { file: string; width: number; height: number; alt: string; raster?: string; rasterSourceSha256?: string };
const manifest = JSON.parse(read('manifest.json').toString()) as { schemaVersion: number; rawBase: string; assets: Asset[] };
const parse = (file: string) => new JSDOM(read(file).toString(), { contentType: 'image/svg+xml' });

describe('brand media kit', () => {
  it('indexes every required SVG and raster, with usable README URLs', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.rawBase).toBe('https://raw.githubusercontent.com/ashlrai/phantom/master/docs/brand/');
    expect(manifest.assets.map(({ file }) => file).sort()).toEqual([
      'og-card.svg', 'org-banner-light.svg', 'org-banner.svg', 'personal-banner.svg', 'phantom-hero-v2.svg',
    ]);
    const files = manifest.assets.flatMap(({ file, raster }) => raster ? [file, raster] : [file]).sort();
    expect(readdirSync(directory).filter((file) => /\.(svg|png)$/.test(file)).sort()).toEqual(files);
    for (const { file, alt } of manifest.assets) {
      expect(read('README.md').toString()).toContain(manifest.rawBase + file);
      expect(alt.trim().length).toBeGreaterThan(20);
    }
  });

  for (const asset of manifest.assets) {
    it(`${asset.file} is well-formed, accessible SVG at its declared dimensions`, () => {
      // XML mode throws on malformed markup; HTML parsing would silently repair it.
      const dom = parse(asset.file);
      try {
        const document = dom.window.document;
        const svg = document.documentElement;
        expect(svg.localName).toBe('svg');
        expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(svg.getAttribute('viewBox')).toBe(`0 0 ${asset.width} ${asset.height}`);
        expect(svg.getAttribute('width')).toBe(String(asset.width));
        expect(svg.getAttribute('height')).toBe(String(asset.height));
        expect(svg.getAttribute('role')).toBe('img');
        for (const tag of ['title', 'desc']) expect(svg.querySelector(tag)?.textContent?.trim().length).toBeGreaterThan(10);
        const labels = svg.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
        expect(labels.length).toBeGreaterThan(0);
        for (const id of labels) expect(document.getElementById(id)?.textContent?.trim()).toBeTruthy();
        expect(read(asset.file).length).toBeLessThan(10 * 1024);
      } finally { dom.window.close(); }
    });

    it(`${asset.file} embeds without external resources or broken local references`, () => {
      const dom = parse(asset.file);
      try {
        const document = dom.window.document;
        const source = read(asset.file).toString();
        expect(document.querySelector('script, foreignObject, image, animate, animateTransform, set')).toBeNull();
        expect(source).not.toMatch(/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|@import|@font-face/i);
        const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const node of document.querySelectorAll('*')) {
          for (const attr of node.attributes) {
            expect(attr.name).not.toMatch(/^on/i);
            if (attr.localName === 'href') {
              expect(attr.value).toMatch(/^#[\w-]+$/);
              expect(ids).toContain(attr.value.slice(1));
            }
          }
        }
        for (const [, raw] of source.matchAll(/url\(([^)]+)\)/g)) {
          const value = raw.trim().replace(/^['"]|['"]$/g, '');
          expect(value).toMatch(/^#[\w-]+$/);
          expect(ids).toContain(value.slice(1));
        }
        expect([...document.querySelectorAll('text')].map((node) => node.textContent).join(' ')).not.toMatch(/\bv?\d+\.\d+\.\d+\b/);
      } finally { dom.window.close(); }
    });
  }

  it('keeps organization theme variants identical in geometry and copy', () => {
    const variants = ['org-banner.svg', 'org-banner-light.svg'].map(parse);
    try {
      const geometry = variants.map(({ window }) => [...window.document.querySelectorAll('path, rect, circle, g, text')].map((node) => ({
        tag: node.localName,
        geometry: ['d', 'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'transform'].map((attr) => node.getAttribute(attr)),
        copy: node.localName === 'text' ? node.textContent : null,
      })));
      expect(geometry[0]).toEqual(geometry[1]);
    } finally { variants.forEach((dom) => dom.window.close()); }
  });

  it('ships the social raster at 1200 × 630 with an acknowledged source digest', () => {
    const asset = manifest.assets.find(({ file }) => file === 'og-card.svg')!;
    const png = read(asset.raster!);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.subarray(12, 16).toString()).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(asset.rasterSourceSha256).toBe(createHash('sha256').update(read(asset.file)).digest('hex'));
  });

  it('keeps the usage guide local links resolvable', () => {
    expect(checkDocumentation({ root, entrypoints: ['docs/brand/README.md'] }).errors).toEqual([]);
  });
});
