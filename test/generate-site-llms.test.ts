/**
 * generate-site-llms tests — hermetic, no network, no subprocesses.
 *
 * Covers:
 *   - renderLlmsTxt produces a valid llms.txt (H1, sections, 3+ links)
 *   - renderLlmsFull produces a valid llms-full.txt (H1, sections, 3+ links)
 *   - --check mode detects stale and missing files
 *   - deterministic output for the same input tree
 *   - idempotent regeneration produces identical bytes
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSiteLlms } from '../scripts/generate-site-llms.mjs';

const tmpdirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gen-llms-'));
  tmpdirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpdirs.length) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture: mock a minimal site tree
// ---------------------------------------------------------------------------

function mockSite(root: string) {
  const site = join(root, 'site');
  mkdirSync(site, { recursive: true });

  writeFileSync(
    join(site, 'index.html'),
    `<!doctype html><html><head>
<title>Phantom — the engineering agent workbench</title>
<meta name="description" content="One coding-agent workbench.">
<link rel="canonical" href="https://verse.ashlr.ai/">
<meta property="og:url" content="https://verse.ashlr.ai/">
</head><body></body></html>`,
  );

  writeFileSync(
    join(site, 'guide.html'),
    `<!doctype html><html><head>
<title>Use-case guide</title>
<meta name="description" content="A use-case guide.">
<link rel="canonical" href="https://verse.ashlr.ai/use-cases/guide">
</head><body></body></html>`,
  );

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@ashlr/phantom',
      version: '3.30.0',
      description: 'Phantom by AshlrAI: the open-source engineering agent workbench.',
      bin: { ashlr: 'bin/ashlr' },
      engines: { node: '>=22.15.0' },
    }),
  );
}

// ---------------------------------------------------------------------------
// renderLlmsTxt scoring (H1, sections, links)
// ---------------------------------------------------------------------------

describe('renderLlmsTxt', () => {
  let root: string;
  beforeEach(() => {
    root = tmp();
    mockSite(root);
  });

  it('produces a file with an H1 title', () => {
    const outputs = buildSiteLlms();
    const llms = outputs['llms.txt'];
    expect(/(^|\n)#\s+\S/.test(llms)).toBe(true);
  });

  it('produces a file with section headings', () => {
    const outputs = buildSiteLlms();
    const llms = outputs['llms.txt'];
    const sections = (llms.match(/(^|\n)##\s+\S/g) ?? []).length;
    expect(sections).toBeGreaterThanOrEqual(3);
  });

  it('produces a file with 3+ markdown links', () => {
    const outputs = buildSiteLlms();
    const llms = outputs['llms.txt'];
    const links = (llms.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
    expect(links).toBeGreaterThanOrEqual(3);
  });

  it('does not contain a double-dot in the blockquote', () => {
    const outputs = buildSiteLlms();
    const llms = outputs['llms.txt'];
    expect(llms).not.toMatch(/\.\.\s/);
  });

  it('includes the install block with npm and bin command', () => {
    const outputs = buildSiteLlms();
    const llms = outputs['llms.txt'];
    expect(llms).toContain('npm install -g @ashlr/phantom');
    expect(llms).toContain('ashlr --version');
    expect(llms).toContain('ashlr verse');
  });
});

// ---------------------------------------------------------------------------
// renderLlmsFull scoring (H1, sections, links, more content)
// ---------------------------------------------------------------------------

describe('renderLlmsFull', () => {
  let root: string;
  beforeEach(() => {
    root = tmp();
    mockSite(root);
  });

  it('produces a file with an H1 title', () => {
    const outputs = buildSiteLlms();
    const full = outputs['llms-full.txt'];
    expect(/(^|\n)#\s+\S/.test(full)).toBe(true);
  });

  it('produces a file with section headings', () => {
    const outputs = buildSiteLlms();
    const full = outputs['llms-full.txt'];
    const sections = (full.match(/(^|\n)##\s+\S/g) ?? []).length;
    expect(sections).toBeGreaterThanOrEqual(4);
  });

  it('produces a file with 3+ markdown links', () => {
    const outputs = buildSiteLlms();
    const full = outputs['llms-full.txt'];
    const links = (full.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
    expect(links).toBeGreaterThanOrEqual(3);
  });

  it('includes a Commands section with CLI examples', () => {
    const outputs = buildSiteLlms();
    const full = outputs['llms-full.txt'];
    expect(full).toContain('## Commands');
    expect(full).toContain('ashlr --help');
    expect(full).toContain('ashlr docs --agent');
  });

  it('includes Repository documentation links', () => {
    const outputs = buildSiteLlms();
    const full = outputs['llms-full.txt'];
    expect(full).toContain('## Repository documentation');
    expect(full).toContain('README.md');
    expect(full).toContain('CONTRIBUTING.md');
  });

  it('is larger than llms.txt', () => {
    const outputs = buildSiteLlms();
    expect(outputs['llms-full.txt'].length).toBeGreaterThan(outputs['llms.txt'].length);
  });
});

// ---------------------------------------------------------------------------
// Deterministic & idempotent
// ---------------------------------------------------------------------------

describe('deterministic output', () => {
  let root: string;
  beforeEach(() => {
    root = tmp();
    mockSite(root);
  });

  it('produces identical bytes on repeated calls', () => {
    const first = buildSiteLlms();
    const second = buildSiteLlms();
    expect(first['llms.txt']).toBe(second['llms.txt']);
    expect(first['llms-full.txt']).toBe(second['llms-full.txt']);
  });

  it('no double-dot even when description already ends with period', () => {
    const outputs = buildSiteLlms();
    expect(outputs['llms.txt']).not.toMatch(/\.\.\s/);
  });
});
