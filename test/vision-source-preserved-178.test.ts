import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Standalone Node documentation checker has no declaration output.
import { checkDocumentation, inspectMarkdown } from '../scripts/check-documentation.mjs';

// RQ-PHX-VISIONDOCUMENTPRESERVE178: consolidate the unique checks retained by
// RQ-PHX-VISIONARTIFACTPRESERVE166 and RQ-PHX-VISIONEXACTRECOVER174. The page
// is historical evidence for its cited revision, not current runtime authority.
const visionPath = 'docs/VISION.md';
const visionUrl = 'https://github.com/ashlrai/phantom/blob/master/docs/VISION.md';
const auditRevision = 'a6f3c32339411eb2d57cb35d4c78c33127bbb8e7';
const auditDate = '2026-10-26';
const pillars = ['1. Assistant UX', '2. Provider-agnostic', '3. Connect any resource', '4. Proactive and fully autonomous'];

const roots: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-vision-178-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function visionSource(): string {
  return readFileSync(join(process.cwd(), visionPath), 'utf8');
}

describe('vision source preserved 178', () => {
  it('preserves the original four pillars in order with the dated capability audit', () => {
    const source = visionSource();
    expect([...source.matchAll(/^### (\d+\. .+)$/gmu)].map((match) => match[1])).toEqual(pillars);
    expect(source).toContain(`Checked against source revision \`${auditRevision}\`\non ${auditDate}.`);
    expect(source).toContain('| Tier-1 paths stay protected | 4 | Shipped |');
    expect(source).toContain('| Local model, loopback by default | 2 | Shipped |');
    expect(source).toContain('| Sidebar for agents, routines, and the machine | 1 | Missing |');
    expect(source.match(/^\| Capability \|/gmu)).toHaveLength(1);
  });

  it('labels the capability audit as historical evidence and points at the evolved direction', () => {
    const source = visionSource();
    const parsed = inspectMarkdown(source);
    expect(parsed.errors).toEqual([]);
    expect(parsed.anchors).toContain('phantom-vision');
    expect([...parsed.anchors]).toEqual(expect.arrayContaining([
      'the-four-pillars', '1-assistant-ux', '2-provider-agnostic',
      '3-connect-any-resource', '4-proactive-and-fully-autonomous', 'where-the-code-is-today',
    ]));
    expect(source).toContain('Historical document');
    expect(source).toContain(`dated ${auditDate} at its cited source revision \`${auditRevision}\``);
    expect(source).toContain('not current runtime evidence and not authority');
    expect(source).toContain('frontier-only merge prose and approval-policy prose are historical targets');
    expect(source).toContain('current Article 1 in [AGENTS.md](../AGENTS.md)');
    expect(source).toContain('this preservation changes no authority');
    expect(source).toContain('[docs/NORTH-STAR.md](NORTH-STAR.md)');
  });

  it.each(['source', 'package'] as const)('keeps the recovered page navigable as an entrypoint in %s mode', (mode) => {
    const result = checkDocumentation({ root: process.cwd(), mode, entrypoints: [visionPath] });
    expect(result).toMatchObject({ ok: true, errors: [], externalRequests: 0, mode });
    expect(result.entrypoints).toEqual([visionPath]);
  });

  it('fails navigation when the recovered page is missing and passes once it is restored', () => {
    const root = fixture({ 'README.md': `| Doc | Use it for |\n| --- | --- |\n| [docs/VISION.md](${visionUrl}) | Product direction |\n` });
    const before = checkDocumentation({ root, entrypoints: ['README.md'] });
    expect(before.ok).toBe(false);
    expect(before.errors).toEqual([expect.objectContaining({ file: 'README.md', href: visionUrl })]);
    mkdirSync(dirname(join(root, visionPath)), { recursive: true });
    writeFileSync(join(root, visionPath), visionSource());
    expect(checkDocumentation({ root, entrypoints: ['README.md'] }).ok).toBe(true);
  });

  it('detects navigation damage: a dropped pillar section fails its fragment link in source mode', () => {
    const source = visionSource();
    const fragmentUrl = `${visionUrl}#the-four-pillars`;
    const root = fixture({
      'README.md': `| Doc | Use it for |\n| --- | --- |\n| [docs/VISION.md](${fragmentUrl}) | Product direction |`,
      [visionPath]: source,
    });
    expect(inspectMarkdown(source).anchors).toContain('the-four-pillars');
    expect(checkDocumentation({ root, entrypoints: ['README.md'] }).ok).toBe(true);
    writeFileSync(join(root, visionPath), source.replace('## The four pillars\n\n', ''));
    const result = checkDocumentation({ root, entrypoints: ['README.md'] });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ href: fragmentUrl, reason: expect.stringContaining('#the-four-pillars') });
  });

  it('checks links to the recovered document and rejects a broken pillar fragment', () => {
    const root = fixture({
      'README.md': '[Vision](docs/VISION.md#the-four-pillars)\n',
      [visionPath]: visionSource(),
    });
    expect(checkDocumentation({ root, entrypoints: ['README.md'] }).ok).toBe(true);
    writeFileSync(join(root, 'README.md'), '[Vision](docs/VISION.md#missing-pillar)\n');
    const result = checkDocumentation({ root, entrypoints: ['README.md'] });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ href: 'docs/VISION.md#missing-pillar' }),
    ]));
  });
});
