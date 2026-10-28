/**
 * Site freshness: the generated blocks in site/ pages must match the
 * repository source of truth, and every ashlr/phm command shown on a page
 * must resolve against the real CLI.
 *
 * scripts/site-freshness.mjs owns the facts: package.json (name, bins, Node
 * floor), the first dated CHANGELOG.md release, the src/cli dispatch switch
 * and completion verb tables, the documented model lists in
 * src/core/verse/model-windows.ts, and the .mcp.json companion servers.
 * synchronize(root, { check: true }) regenerates every managed block and
 * validates every command line inside <pre>/<code> without writing, so a
 * hand-edited version, model list or renamed command fails here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  readFacts,
  regenerate,
  renderBlock,
  synchronize,
  validatePageCommands,
} from '../scripts/site-freshness.mjs';

const ROOT = join(__dirname, '..');
const facts = readFacts(ROOT);

describe('site freshness', () => {
  it('keeps generated blocks in site pages in sync with the source of truth', () => {
    expect(synchronize(ROOT, { check: true })).toEqual([]);
  });

  it('reads the facts the pages are generated from', () => {
    expect(facts.pkgName).toBe('@ashlr/phantom');
    expect(facts.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(facts.released).toMatch(/^\d+\.\d+\.\d+$/);
    expect(facts.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(facts.nodeFloor).toMatch(/^\d+\.\d+/);
    expect(facts.mcpServers.length).toBeGreaterThan(0);
    expect(facts.cliTop.has('verse')).toBe(true);
    expect(facts.models.claude.length).toBeGreaterThan(0);
    expect(facts.models.codex.length).toBeGreaterThan(0);
    expect(facts.models.grok.length).toBeGreaterThan(0);
  });

  it('renders each managed block from facts', () => {
    expect(renderBlock('node-floor', facts)).toBe(facts.nodeFloor);
    expect(renderBlock('mcp-servers', facts)).toBe('ashlr, lexicon, locus, phantom-secrets, stack');
    expect(renderBlock('models-grok', facts)).toBe('Grok 4.7, 4.7 Fast, 4.6, 4.5');
    expect(renderBlock('install-commands', facts)).toContain(`npm i -g ${facts.pkgName}`);
    expect(renderBlock('release-line', facts)).toContain(facts.released);
    expect(renderBlock('release-line', facts)).toContain(facts.releaseDate);
    const ld = JSON.parse(
      renderBlock('jsonld', facts).replace(/<\/?script[^>]*>/g, ''),
    );
    const app = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'SoftwareApplication');
    expect(app.softwareVersion).toBe(facts.released);
    expect(app.dateModified).toBe(facts.releaseDate);
    expect(() => renderBlock('bogus-name', facts)).toThrow(/Unknown freshness block/);
  });

  it('flags a page whose generated value drifts from source', () => {
    const stale = 'Node.js <!-- fresh:begin node-floor -->9.9<!-- fresh:end -->+ and Git';
    const regenerated = regenerate(stale, facts);
    expect(regenerated).not.toBe(stale);
    expect(regenerated).toContain(`<!-- fresh:begin node-floor -->${facts.nodeFloor}<!-- fresh:end -->`);
  });

  it('fails closed on malformed, unbalanced or unknown markers', () => {
    const wrap = (name: string) => `<!-- fresh:begin ${name} -->x<!-- fresh:end -->`;
    expect(() => regenerate(wrap('bogus-name'), facts)).toThrow(/Unknown freshness block/);
    expect(() => regenerate('<!-- fresh:begin node-floor -->x', facts)).toThrow(/Unclosed/);
    expect(() => regenerate('<!-- fresh:end -->', facts)).toThrow(/Unmatched/);
    expect(() => regenerate(wrap('node-floor') + wrap('node-floor'), facts)).not.toThrow();
    expect(() => regenerate('<!-- fresh:begin node-floor --><!-- fresh:begin node-floor --><!-- fresh:end -->', facts))
      .toThrow(/Nested/);
    expect(() => regenerate('<!--fresh:begin node-floor-->', facts)).toThrow(/Malformed/);
    expect(() => regenerate('<!-- fresh:typo -->', facts)).toThrow(/Malformed/);
  });

  it('rejects page commands the CLI does not dispatch', () => {
    expect(() => validatePageCommands('<pre>ashlr frobnicate now</pre>', facts))
      .toThrow(/'frobnicate' is not a dispatched command/);
    expect(() => validatePageCommands('<pre>ashlr devin teleport</pre>', facts))
      .toThrow(/'devin teleport' is not a verb/);
    expect(() => validatePageCommands('<pre>ashlr devin budget --notaflag 5</pre>', facts))
      .toThrow(/--notaflag/);
    expect(() => validatePageCommands('<pre>ashlr resources bogus prepare</pre>', facts))
      .toThrow(/'resources bogus'/);
  });

  it('accepts the commands the pages actually show', () => {
    const html = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8');
    expect(() => validatePageCommands(html, facts, 'site/index.html')).not.toThrow();
    const eco = readFileSync(join(ROOT, 'site', 'ecosystem.html'), 'utf8');
    expect(() => validatePageCommands(eco, facts, 'site/ecosystem.html')).not.toThrow();
    for (const sample of [
      '<pre>ashlr resources profile prepare --provider claude \\\n  --directory /d \\\n  --executable /e</pre>',
      '<code>phm --version</code>',
      '<pre>ashlr authority resident start</pre>',
      '<pre>ashlr benchmark --compare-reports BASE CANDIDATE</pre>',
    ]) {
      expect(() => validatePageCommands(sample, facts)).not.toThrow();
    }
  });
});
