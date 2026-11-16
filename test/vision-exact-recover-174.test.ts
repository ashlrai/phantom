import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Standalone Node documentation checker has no declaration output.
import { checkDocumentation, inspectMarkdown } from '../scripts/check-documentation.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('retains the dated four-pillar vision as historical context with a current-direction pointer', () => {
  const source = readFileSync(join(process.cwd(), 'docs/VISION.md'), 'utf8');
  const parsed = inspectMarkdown(source);
  expect(parsed.errors).toEqual([]);
  expect([...parsed.anchors]).toEqual(expect.arrayContaining([
    'the-four-pillars', '1-assistant-ux', '2-provider-agnostic',
    '3-connect-any-resource', '4-proactive-and-fully-autonomous', 'where-the-code-is-today',
  ]));
  expect(source).toContain('a6f3c32339411eb2d57cb35d4c78c33127bbb8e7');
  expect(source).toContain('2026-10-26');
  expect(source).toContain('not current runtime evidence and not authority');
  expect(source).toContain('[docs/NORTH-STAR.md](NORTH-STAR.md)');
});

it('checks links to the recovered document and rejects a broken pillar fragment', () => {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-vision-174-'));
  roots.push(root);
  mkdirSync(join(root, 'docs'), { recursive: true });
  const source = readFileSync(join(process.cwd(), 'docs/VISION.md'), 'utf8');
  writeFileSync(join(root, 'README.md'), '[Vision](docs/VISION.md#the-four-pillars)\n');
  writeFileSync(join(root, 'docs/VISION.md'), source);
  expect(checkDocumentation({ root, entrypoints: ['README.md'] }).ok).toBe(true);
  writeFileSync(join(root, 'README.md'), '[Vision](docs/VISION.md#missing-pillar)\n');
  const result = checkDocumentation({ root, entrypoints: ['README.md'] });
  expect(result.ok).toBe(false);
  expect(result.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ href: 'docs/VISION.md#missing-pillar' }),
  ]));
});
