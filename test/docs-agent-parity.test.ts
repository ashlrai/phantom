/**
 * Agent-readable docs parity: llms.txt completeness (fails CI when a docs page
 * is missing), the docs-to-site Markdown build, and the read-only docs MCP.
 * Offline: reads the checkout and temp dirs only.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDocsServer } from '../src/mcp/docs-server.js';
import {
  isSafeSlug, listDocsPages, llmsCovers, readDocsPage, renderLlmsTxt, searchDocsPages, uncoveredPages,
} from '../scripts/lib/docs-pages.mjs';

const ROOT = join(__dirname, '..');
const DOCS = join(ROOT, 'docs');
const temps: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureDocs(): string {
  const dir = mkdtempSync(join(tmpdir(), 'docs-parity-'));
  temps.push(dir);
  mkdirSync(join(dir, 'sub'));
  mkdirSync(join(dir, 'internal'));
  writeFileSync(join(dir, 'ALPHA.md'), '# Alpha guide\n\nAlpha explains the zebra protocol.\n');
  writeFileSync(join(dir, 'sub', 'BETA.md'), '# Beta\n\nBeta covers llama routing.\n');
  writeFileSync(join(dir, 'internal', 'SECRET.md'), '# Internal\n\nnot public\n');
  writeFileSync(join(dir, 'llms.txt'), '# Fixture\n\n- [Alpha](ALPHA.md): curated\n');
  return dir;
}

async function connect(docsDir: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docs-test', version: '1.0.0' });
  clients.push(client);
  await createDocsServer(docsDir).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as { text: string }[])[0]!.text;

describe('docs/llms.txt completeness', () => {
  it('mentions every docs page (add a page, then run node scripts/generate-docs-llms.mjs)', () => {
    const llms = readFileSync(join(DOCS, 'llms.txt'), 'utf8');
    const missing = listDocsPages(DOCS).filter(p => !llmsCovers(llms, p.slug)).map(p => p.slug);
    expect(missing).toEqual([]);
  });

  it('is exactly what the generator produces', () => {
    expect(() => execFileSync('node', ['scripts/generate-docs-llms.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' })).not.toThrow();
  });

  it('detects a page missing from llms.txt and regenerates idempotently', () => {
    const dir = fixtureDocs();
    const pages = listDocsPages(dir);
    const llms = readFileSync(join(dir, 'llms.txt'), 'utf8');
    expect(uncoveredPages(llms, pages).map(p => p.slug)).toEqual(['sub/BETA']);
    const next = renderLlmsTxt(llms, pages);
    expect(next).toContain('[Beta](sub/BETA.md): Beta covers llama routing.');
    expect(pages.every(p => llmsCovers(next, p.slug))).toBe(true);
    expect(renderLlmsTxt(next, pages)).toBe(next);
  });
});

describe('docs page model', () => {
  it('lists public pages only and rejects unsafe slugs', () => {
    const dir = fixtureDocs();
    expect(listDocsPages(dir).map(p => p.slug)).toEqual(['ALPHA', 'sub/BETA']);
    expect(readDocsPage(dir, 'internal/SECRET')).toBeNull();
    for (const bad of ['../etc/passwd', '/abs', 'a//b', 'ALPHA/../ALPHA', '', 'a\\b']) expect(isSafeSlug(bad)).toBe(false);
    expect(readDocsPage(dir, '../docs-parity/ALPHA')).toBeNull();
    expect(searchDocsPages(dir, 'llama')[0]?.slug).toBe('sub/BETA');
  });
});

describe('docs site build', () => {
  it('writes every page as .md plus llms.txt and llms-full.txt under the output dir', () => {
    const out = mkdtempSync(join(ROOT, '.tmp-docs-site-'));
    temps.push(out);
    const rel = out.slice(ROOT.length + 1);
    // --check in a scratch copy is not possible; the real tree is already in sync, so a write run is a no-op for docs/llms.txt.
    execFileSync('node', ['scripts/generate-docs-llms.mjs', '--out', rel], { cwd: ROOT, stdio: 'pipe' });
    const pages = listDocsPages(DOCS);
    expect(readFileSync(join(out, 'docs', 'ARCHITECTURE.md'), 'utf8')).toBe(readFileSync(join(DOCS, 'ARCHITECTURE.md'), 'utf8'));
    const full = readFileSync(join(out, 'docs', 'llms-full.txt'), 'utf8');
    expect(full).toContain('Source: https://verse.ashlr.ai/docs/ARCHITECTURE.md');
    expect(full).toContain(`${pages.length} pages.`);
    expect(readFileSync(join(out, 'docs', 'llms.txt'), 'utf8')).toBe(readFileSync(join(DOCS, 'llms.txt'), 'utf8'));
    expect(() => execFileSync('node', ['scripts/generate-docs-llms.mjs', '--out', '../outside'], { cwd: ROOT, stdio: 'pipe' })).toThrow();
  });
});

describe('docs MCP server', () => {
  it('lists the three read-only tools', async () => {
    const client = await connect(fixtureDocs());
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(['search', 'list_pages', 'get_page']);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('returns a known page from the real docs, offline', async () => {
    const client = await connect(DOCS);
    const page = JSON.parse(textOf(await client.callTool({ name: 'get_page', arguments: { slug: 'ARCHITECTURE' } })));
    expect(page.title).toBe('Architecture');
    expect(page.url).toBe('https://verse.ashlr.ai/docs/ARCHITECTURE.md');
    expect(page.text).toBe(readFileSync(join(DOCS, 'ARCHITECTURE.md'), 'utf8'));
    expect(page.truncated).toBe(false);
    const hits = JSON.parse(textOf(await client.callTool({ name: 'search', arguments: { query: 'architecture overview', limit: 5 } })));
    expect(hits.results.length).toBeGreaterThan(0);
    const listed = JSON.parse(textOf(await client.callTool({ name: 'list_pages', arguments: { prefix: 'contracts/' } })));
    expect(listed.count).toBeGreaterThan(0);
    expect(listed.pages.every((p: { slug: string }) => p.slug.startsWith('contracts/'))).toBe(true);
  });

  it('searches and lists a fixture tree', async () => {
    const client = await connect(fixtureDocs());
    const hits = JSON.parse(textOf(await client.callTool({ name: 'search', arguments: { query: 'zebra' } })));
    expect(hits.results.map((r: { slug: string }) => r.slug)).toEqual(['ALPHA']);
    const listed = JSON.parse(textOf(await client.callTool({ name: 'list_pages', arguments: {} })));
    expect(listed.pages.map((p: { slug: string }) => p.slug)).toEqual(['ALPHA', 'sub/BETA']);
  });

  it('rejects traversal, unknown tools and unknown fields without leaking paths', async () => {
    const dir = fixtureDocs();
    const client = await connect(dir);
    await expect(client.callTool({ name: 'get_page', arguments: { slug: '../../etc/passwd' } })).rejects.toThrow();
    await expect(client.callTool({ name: 'get_page', arguments: { slug: 'ALPHA', extra: 1 } })).rejects.toThrow();
    await expect(client.callTool({ name: 'search', arguments: { query: 'x', limit: 999 } })).rejects.toThrow();
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow();
    const missing = await client.callTool({ name: 'get_page', arguments: { slug: 'internal/SECRET' } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).not.toContain(dir);
    expect(textOf(missing)).not.toContain('not public');
  });
});
