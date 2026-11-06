/**
 * agent-readiness tests - hermetic, no network, no subprocesses.
 *
 * Covers:
 *   - each rubric check against in-memory fixture trees
 *   - the agent-readiness.v1 artifact schema (accept + reject)
 *   - committed fixtures: a site gains points after llms.txt is added
 *   - artifact write path: previous/delta are computed on rewrite
 *   - repo targets mark page checks not applicable
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_READINESS_CHECK_IDS,
  AGENT_READINESS_SCHEMA,
  AGENT_READINESS_WEIGHTS,
  agentReadinessArtifactName,
  createFsReadinessSource,
  createMemoryReadinessSource,
  defaultAgentReadinessDir,
  parseAgentReadinessArtifact,
  readAgentReadinessArtifact,
  scoreAgentReadinessTarget,
  writeAgentReadinessArtifacts,
  type AgentReadinessCheckId,
} from '../src/core/observability/agent-readiness.js';

const FIXTURES = join(__dirname, 'fixtures', 'agent-readiness');
const NOW = '2026-10-26T12:00:00.000Z';

const tmpdirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-readiness-'));
  tmpdirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpdirs.length) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

function siteWith(files: Record<string, string>) {
  return createMemoryReadinessSource(files);
}

function check(files: Record<string, string>, id: AgentReadinessCheckId, kind: 'site' | 'repo' = 'site') {
  const report = scoreAgentReadinessTarget({ kind, source: siteWith(files), now: NOW });
  const result = report.checks.find((c) => c.id === id);
  expect(result).toBeDefined();
  return result!;
}

const GOOD_PAGE = `<!doctype html><html><head>
<title>Page</title>
<meta name="description" content="d">
<link rel="canonical" href="https://x.example/">
<meta property="og:title" content="t">
<meta property="og:description" content="d">
<meta property="og:type" content="website">
<meta property="og:url" content="https://x.example/">
<meta property="og:image" content="https://x.example/i.png">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">{"@type":"SoftwareApplication","name":"X"}</script>
</head><body><h1>P</h1><h2>s</h2></body></html>`;

const GOOD_LLMS = '# Title\n\n> Summary\n\n## Docs\n\n- [a](https://x.example/a)\n- [b](https://x.example/b)\n- [c](https://x.example/c)\n';

// ---------------------------------------------------------------------------
// llmsTxt
// ---------------------------------------------------------------------------

describe('agent-readiness llmsTxt check', () => {
  it('scores 0 when llms.txt and llms-full.txt are absent', () => {
    expect(check({ 'index.html': GOOD_PAGE }, 'llmsTxt').score).toBe(0);
  });

  it('scores partial when llms.txt is valid but llms-full.txt is absent', () => {
    const result = check({ 'llms.txt': GOOD_LLMS, 'index.html': GOOD_PAGE }, 'llmsTxt');
    expect(result.score).toBeCloseTo(0.6, 5);
    expect(result.findings.join(' ')).toContain('llms-full.txt missing');
  });

  it('scores 1 with valid llms.txt and llms-full.txt', () => {
    const result = check(
      { 'llms.txt': GOOD_LLMS, 'llms-full.txt': `${GOOD_LLMS}\n## More\n\n- [d](https://x.example/d)\n`, 'index.html': GOOD_PAGE },
      'llmsTxt',
    );
    expect(result.score).toBe(1);
  });

  it('penalizes an llms.txt without a title or links', () => {
    const result = check({ 'llms.txt': 'hello world\n', 'index.html': GOOD_PAGE }, 'llmsTxt');
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(0.5);
    expect(result.findings.join(' ')).toContain('no H1 title');
  });
});

// ---------------------------------------------------------------------------
// agentsMd
// ---------------------------------------------------------------------------

describe('agent-readiness agentsMd check', () => {
  it('scores 0 when AGENTS.md is absent', () => {
    expect(check({ 'index.html': GOOD_PAGE }, 'agentsMd').score).toBe(0);
  });

  it('scores partial for a thin AGENTS.md without sections or tooling', () => {
    const result = check({ 'AGENTS.md': 'See the readme.\n', 'index.html': GOOD_PAGE }, 'agentsMd');
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(0.7);
  });

  it('scores 1 for a structured AGENTS.md with commands', () => {
    const md = `# Guide\n\n## Setup\n\n${'context '.repeat(60)}\n\n## Commands\n\n- Build: \`npm run build\`\n- Test: \`npm test\`\n`;
    expect(check({ 'AGENTS.md': md, 'index.html': GOOD_PAGE }, 'agentsMd').score).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// jsonLd
// ---------------------------------------------------------------------------

describe('agent-readiness jsonLd check', () => {
  it('scores 0 with no JSON-LD', () => {
    expect(check({ 'index.html': '<html><body><h1>x</h1></body></html>' }, 'jsonLd').score).toBe(0);
  });

  it('scores 1 for a named SoftwareApplication', () => {
    expect(check({ 'index.html': GOOD_PAGE }, 'jsonLd').score).toBe(1);
  });

  it('scores partial when JSON-LD lacks SoftwareApplication', () => {
    const html = '<html><head><script type="application/ld+json">{"@type":"WebSite","name":"X"}</script></head></html>';
    expect(check({ 'index.html': html }, 'jsonLd').score).toBeCloseTo(0.4, 5);
  });

  it('scores low for unparseable JSON-LD', () => {
    const html = '<html><head><script type="application/ld+json">{oops</script></head></html>';
    const result = check({ 'index.html': html }, 'jsonLd');
    expect(result.score).toBeCloseTo(0.2, 5);
    expect(result.findings.join(' ')).toContain('failed to parse');
  });
});

// ---------------------------------------------------------------------------
// sitemapRobots
// ---------------------------------------------------------------------------

describe('agent-readiness sitemapRobots check', () => {
  it('scores 0 with neither file', () => {
    expect(check({ 'index.html': GOOD_PAGE }, 'sitemapRobots').score).toBe(0);
  });

  it('scores 0.6 for a sitemap without robots.txt', () => {
    const sitemap = '<urlset><url><loc>https://x.example/</loc></url></urlset>';
    expect(check({ 'index.html': GOOD_PAGE, 'sitemap.xml': sitemap }, 'sitemapRobots').score).toBeCloseTo(0.6, 5);
  });

  it('scores 1 for sitemap plus robots declaring it', () => {
    const sitemap = '<urlset><url><loc>https://x.example/</loc></url></urlset>';
    const robots = 'User-agent: *\nAllow: /\nSitemap: https://x.example/sitemap.xml\n';
    const result = check({ 'index.html': GOOD_PAGE, 'sitemap.xml': sitemap, 'robots.txt': robots }, 'sitemapRobots');
    expect(result.score).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// openGraph
// ---------------------------------------------------------------------------

describe('agent-readiness openGraph check', () => {
  it('scores 1 when every page carries all signals', () => {
    expect(check({ 'index.html': GOOD_PAGE }, 'openGraph').score).toBe(1);
  });

  it('averages coverage across pages', () => {
    const bare = '<html><head><title>t</title></head><body><h1>x</h1></body></html>';
    const result = check({ 'index.html': GOOD_PAGE, 'bare.html': bare }, 'openGraph');
    // GOOD_PAGE = 1.0; bare has only <title> = 0.15.
    expect(result.score).toBeCloseTo((1 + 0.15) / 2, 5);
    expect(result.findings.join(' ')).toContain('bare.html');
  });
});

// ---------------------------------------------------------------------------
// canonical
// ---------------------------------------------------------------------------

describe('agent-readiness canonical check', () => {
  it('scores 1 for absolute canonical URLs', () => {
    expect(check({ 'index.html': GOOD_PAGE }, 'canonical').score).toBe(1);
  });

  it('scores partial for a relative canonical', () => {
    const html = '<html><head><link rel="canonical" href="/relative"></head></html>';
    expect(check({ 'index.html': html }, 'canonical').score).toBeCloseTo(0.4, 5);
  });

  it('scores 0 without canonical', () => {
    expect(check({ 'index.html': '<html><body></body></html>' }, 'canonical').score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// headings
// ---------------------------------------------------------------------------

describe('agent-readiness headings check', () => {
  it('scores 1 for ordered headings with one h1', () => {
    expect(check({ 'index.html': GOOD_PAGE }, 'headings').score).toBe(1);
  });

  it('penalizes a skipped level', () => {
    const html = '<html><body><h1>a</h1><h3>skip</h3></body></html>';
    const result = check({ 'index.html': html }, 'headings');
    expect(result.score).toBe(0);
    expect(result.findings.join(' ')).toContain('skipped');
  });

  it('penalizes multiple h1 elements', () => {
    const html = '<html><body><h1>a</h1><h1>b</h1></body></html>';
    expect(check({ 'index.html': html }, 'headings').score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

describe('agent-readiness capabilities check', () => {
  it('scores 0 with no capability or install evidence', () => {
    expect(check({ 'index.html': GOOD_PAGE }, 'capabilities').score).toBe(0);
  });

  it('scores 1 for a machine-readable capabilities.json', () => {
    const caps = JSON.stringify({ name: 'x', version: '1.0.0', capabilities: ['fmt'], install: 'npm i x' });
    expect(check({ 'capabilities.json': caps }, 'capabilities').score).toBe(1);
  });

  it('scores partial for an HTML install page with commands', () => {
    const html = '<html><body><h1>Install</h1><pre><code>npm install -g x</code></pre></body></html>';
    expect(check({ 'install.html': html }, 'capabilities').score).toBeCloseTo(0.5, 5);
  });

  it('scores partial for a Markdown install doc', () => {
    const md = '# Install\n\n```sh\nnpm install -g x\n```\n';
    expect(check({ 'INSTALL.md': md }, 'capabilities').score).toBeCloseTo(0.4, 5);
  });
});

// ---------------------------------------------------------------------------
// mcpServer
// ---------------------------------------------------------------------------

describe('agent-readiness mcpServer check', () => {
  it('scores 0 without server.json', () => {
    expect(check({ 'index.html': GOOD_PAGE }, 'mcpServer').score).toBe(0);
  });

  it('scores 1 for a valid server.json', () => {
    const server = JSON.stringify({
      name: 'com.example/tool', description: 'd', version: '1.0.0',
      packages: [{ registryType: 'npm', identifier: 'x', version: '1.0.0' }],
    });
    expect(check({ 'server.json': server }, 'mcpServer').score).toBe(1);
  });

  it('scores partial when required fields are missing', () => {
    const server = JSON.stringify({ name: 'com.example/tool' });
    const result = check({ 'server.json': server }, 'mcpServer');
    expect(result.score).toBeCloseTo(0.4, 5);
    expect(result.findings.join(' ')).toContain('description');
  });

  it('scores low for invalid JSON', () => {
    expect(check({ 'server.json': '{nope' }, 'mcpServer').score).toBeCloseTo(0.2, 5);
  });
});

// ---------------------------------------------------------------------------
// pageWeight
// ---------------------------------------------------------------------------

describe('agent-readiness pageWeight check', () => {
  it('scores 1 for small pages and a small site', () => {
    expect(check({ 'index.html': GOOD_PAGE, 'a.css': 'body{}' }, 'pageWeight').score).toBe(1);
  });

  it('drops the per-page tier for a heavy page', () => {
    const heavy = `<html><body>${'x'.repeat(600 * 1024)}</body></html>`;
    const result = check({ 'index.html': heavy }, 'pageWeight');
    expect(result.score).toBeCloseTo(0.5 * 0.2 + 0.5 * 1, 5);
  });

  it('drops the total tier for a heavy site', () => {
    const result = check({ 'index.html': GOOD_PAGE, 'blob.bin': 'y'.repeat(3 * 1024 * 1024) }, 'pageWeight');
    expect(result.score).toBeCloseTo(0.5 * 1 + 0.5 * 0.6, 5);
  });
});

// ---------------------------------------------------------------------------
// Committed fixtures: llms.txt delta and target kinds
// ---------------------------------------------------------------------------

describe('agent-readiness committed fixtures', () => {
  it('site score increases after adding llms.txt and llms-full.txt', () => {
    const before = scoreAgentReadinessTarget({
      kind: 'site',
      source: createFsReadinessSource(join(FIXTURES, 'site-no-llms')),
      path: 'test/fixtures/agent-readiness/site-no-llms',
      now: NOW,
    });
    const after = scoreAgentReadinessTarget({
      kind: 'site',
      source: createFsReadinessSource(join(FIXTURES, 'site-llms')),
      path: 'test/fixtures/agent-readiness/site-llms',
      now: NOW,
    });
    const beforeCheck = before.checks.find((c) => c.id === 'llmsTxt')!;
    const afterCheck = after.checks.find((c) => c.id === 'llmsTxt')!;
    expect(beforeCheck.score).toBe(0);
    expect(afterCheck.score).toBe(1);
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.score - before.score).toBeCloseTo(AGENT_READINESS_WEIGHTS.llmsTxt, 5);
    expect(after.score).toBe(100);
  });

  it('a healthy repo scores 100 with page checks marked not applicable', () => {
    const report = scoreAgentReadinessTarget({
      kind: 'repo',
      source: createFsReadinessSource(join(FIXTURES, 'repo-healthy')),
      path: 'test/fixtures/agent-readiness/repo-healthy',
      now: NOW,
    });
    const inapplicable = report.checks.filter((c) => !c.applicable).map((c) => c.id);
    expect(inapplicable.sort()).toEqual(
      ['canonical', 'headings', 'jsonLd', 'openGraph', 'pageWeight', 'sitemapRobots'].sort(),
    );
    expect(report.totals.applicable).toBe(45);
    expect(report.score).toBe(100);
  });

  it('a bare repo scores low but still earns partial credit for hints', () => {
    const report = scoreAgentReadinessTarget({
      kind: 'repo',
      source: createFsReadinessSource(join(FIXTURES, 'repo-bare')),
      path: 'test/fixtures/agent-readiness/repo-bare',
      now: NOW,
    });
    expect(report.score).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------------------
// Schema: agent-readiness.v1 artifacts validate and reject cleanly
// ---------------------------------------------------------------------------

describe('agent-readiness.v1 schema', () => {
  function fixtureReport() {
    return scoreAgentReadinessTarget({
      kind: 'site',
      source: createFsReadinessSource(join(FIXTURES, 'site-llms')),
      path: 'test/fixtures/agent-readiness/site-llms',
      now: NOW,
    });
  }

  it('round-trips a scored report', () => {
    const report = fixtureReport();
    const parsed = parseAgentReadinessArtifact(`${JSON.stringify(report, null, 2)}\n`);
    expect(parsed.schema).toBe(AGENT_READINESS_SCHEMA);
    expect(parsed.score).toBe(report.score);
    expect(parsed.checks.map((c) => c.id)).toEqual([...AGENT_READINESS_CHECK_IDS]);
  });

  it('rejects a foreign schema tag', () => {
    const report = fixtureReport();
    const tampered = JSON.stringify({ ...report, schema: 'agent-readiness.v2' });
    expect(() => parseAgentReadinessArtifact(tampered)).toThrow(/Invalid agent-readiness artifact/);
  });

  it('rejects a missing check', () => {
    const report = fixtureReport();
    const tampered = JSON.stringify({ ...report, checks: report.checks.slice(1) });
    expect(() => parseAgentReadinessArtifact(tampered)).toThrow(/Invalid agent-readiness artifact/);
  });

  it('rejects an out-of-range check score', () => {
    const report = fixtureReport();
    const checks = report.checks.map((c) => (c.id === 'llmsTxt' ? { ...c, score: 7 } : c));
    expect(() => parseAgentReadinessArtifact(JSON.stringify({ ...report, checks }))).toThrow();
  });

  it('rejects non-JSON input', () => {
    expect(() => parseAgentReadinessArtifact('not json')).toThrow(/JSON/);
  });
});

// ---------------------------------------------------------------------------
// Artifact persistence: naming, delta, metrics dir resolution
// ---------------------------------------------------------------------------

describe('agent-readiness artifacts on disk', () => {
  it('writes agent-readiness.v1 artifacts and computes delta on rewrite', () => {
    const outDir = join(tmp(), 'metrics', 'agent-readiness');
    const first = scoreAgentReadinessTarget({
      kind: 'site',
      source: createFsReadinessSource(join(FIXTURES, 'site-no-llms')),
      path: 'site',
      label: 'site-no-llms',
      now: NOW,
    });
    const [written] = writeAgentReadinessArtifacts([first], outDir);
    expect(readFileSync(written!.path, 'utf8')).toContain('"schema": "agent-readiness.v1"');
    expect(written!.report.delta).toBeNull();

    const second = scoreAgentReadinessTarget({
      kind: 'site',
      source: createFsReadinessSource(join(FIXTURES, 'site-llms')),
      path: 'site',
      label: 'site-no-llms',
      now: '2026-10-27T12:00:00.000Z',
    });
    const [rewritten] = writeAgentReadinessArtifacts([second], outDir);
    expect(rewritten!.report.previous).toEqual({ score: first.score, generatedAt: NOW });
    expect(rewritten!.report.delta).toBeCloseTo(15, 5);
    const persisted = readAgentReadinessArtifact(rewritten!.path);
    expect(persisted!.delta).toBeCloseTo(15, 5);
  });

  it('refuses to overwrite a malformed existing artifact', () => {
    const outDir = tmp();
    const name = join(outDir, 'site-x.json');
    writeFileSync(name, '{"schema":"something-else"}');
    const report = scoreAgentReadinessTarget({
      kind: 'site', source: siteWith({ 'index.html': GOOD_PAGE }), path: 'x', label: 'x', now: NOW,
    });
    expect(() => writeAgentReadinessArtifacts([report], outDir)).toThrow(/agent-readiness/);
  });

  it('returns null for an absent artifact and throws for a malformed one', () => {
    const dir = tmp();
    expect(readAgentReadinessArtifact(join(dir, 'missing.json'))).toBeNull();
    writeFileSync(join(dir, 'bad.json'), '[]');
    expect(() => readAgentReadinessArtifact(join(dir, 'bad.json'))).toThrow();
  });

  it('names artifacts by kind and slug', () => {
    const report = scoreAgentReadinessTarget({
      kind: 'site', source: siteWith({ 'index.html': GOOD_PAGE }), path: 'x', label: 'My Site!', now: NOW,
    });
    expect(agentReadinessArtifactName(report)).toBe('site-my-site.json');
  });

  it('resolves the default output dir under ASHLR_HOME metrics inputs', () => {
    expect(defaultAgentReadinessDir({ ASHLR_HOME: '/tmp/ash' } as NodeJS.ProcessEnv)).toBe(
      join('/tmp/ash', 'metrics', 'agent-readiness'),
    );
    expect(defaultAgentReadinessDir({} as NodeJS.ProcessEnv)).toContain(join('.ashlr', 'metrics', 'agent-readiness'));
  });
});
