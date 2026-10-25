/**
 * M31 — native MCP tool registry (src/core/mcp-native.ts).
 *
 * Hermetic: every test runs under an isolated tmp HOME (h1-fixture); no real
 * ~/.ashlr is ever touched, no network, no downstream MCP servers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import {
  nativeToolDefs,
  listNativeTools,
  isNativeTool,
  callNativeTool,
  renderToolText,
} from '../src/core/mcp-native.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

/** Seed one genome hub entry under the tmp HOME. */
function seedHubEntry(title: string, text: string): void {
  const dir = join(fx.ashlrDir, 'genome');
  mkdirSync(dir, { recursive: true });
  const entry = {
    id: `test-${title}`,
    project: null,
    source: 'hub',
    title,
    text,
    tags: ['test'],
    ts: new Date().toISOString(),
  };
  writeFileSync(join(dir, 'hub.jsonl'), JSON.stringify(entry) + '\n', { flag: 'a' });
}

function resultText(r: { content: { type: 'text'; text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe('native tool registry', () => {
  it('exposes the contracted native tools', () => {
    const names = nativeToolDefs().map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'ashlr_ask',
        'ashlr_backlog',
        'ashlr_browser_task',
        'ashlr_comms',
        'ashlr_desktop_open',
        'ashlr_fleet_status',
        'ashlr_health',
        'ashlr_impact',
        'ashlr_inbox_list',
        'ashlr_inbox_propose',
        'ashlr_learn',
        'ashlr_north_star',
        'ashlr_orient',
        'ashlr_oversight',
        'ashlr_pulse',
        'ashlr_racing',
        'ashlr_recall',
        'ashlr_routing',
        'ashlr_scorecard',
        'ashlr_self_heal',
        'ashlr_status',
        'ashlr_website_publish',
        'ashlr_website_status',
        'phm_proactive_agents_list',
        'phm_proactive_agents_create',
        'phm_proactive_agents_update',
        'phm_proactive_agents_delete',
        'phm_task_context',
        'phm_team_claim',
        'phm_team_context_add',
        'phm_team_context_get',
        'phm_team_handoff',
        'phm_team_publish',
        'phm_team_register',
        'phm_team_view',
      ].sort(),
    );
  });

  it('every tool has a valid object inputSchema and a safety class', () => {
    for (const t of nativeToolDefs()) {
      expect(t.description.length).toBeGreaterThan(20);
      expect((t.inputSchema as { type?: string }).type).toBe('object');
      expect(['read', 'append', 'proposal']).toContain(t.safety);
    }
  });

  it('listNativeTools returns the tools/list projection (no safety/handler)', () => {
    const listed = listNativeTools();
    expect(listed).toHaveLength(nativeToolDefs().length);
    for (const t of listed) {
      expect(Object.keys(t).sort()).toEqual(['description', 'inputSchema', 'name']);
    }
  });

  it('isNativeTool distinguishes native names from downstream-namespaced ones', () => {
    expect(isNativeTool('ashlr_recall')).toBe(true);
    expect(isNativeTool('someserver__sometool')).toBe(false);
    expect(isNativeTool('ashlr__recall')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// callNativeTool — pipeline behavior
// ---------------------------------------------------------------------------

describe('callNativeTool', () => {
  it('never throws on an unknown tool — returns isError content', async () => {
    const r = await callNativeTool('ashlr_nope', {});
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('Unknown native tool');
  });

  it('rejects missing required args with isError (no throw)', async () => {
    const r = await callNativeTool('ashlr_recall', {});
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('missing required argument "query"');
  });

  it('rejects wrong-typed args', async () => {
    const r = await callNativeTool('ashlr_recall', { query: 'x', limit: 'five' });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('"limit" must be a number');
  });

  it('rejects enum violations', async () => {
    const r = await callNativeTool('ashlr_pulse', { window: '90d' });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('must be one of');
  });

  it('ashlr_recall round-trips against a seeded hub store', async () => {
    seedHubEntry('NodeNext ESM convention', 'ashlr-hub uses NodeNext ESM with .js import specifiers');
    const r = await callNativeTool('ashlr_recall', { query: 'NodeNext ESM convention' });
    expect(r.isError).toBeUndefined();
    const hits = JSON.parse(resultText(r)) as { title: string }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toBe('NodeNext ESM convention');
  });

  it('ashlr_backlog with no persisted backlog returns a helpful note, not an error', async () => {
    const r = await callNativeTool('ashlr_backlog', {});
    expect(r.isError).toBeUndefined();
    expect(resultText(r)).toContain('ashlr backlog refresh');
  });

  it('ashlr_health on a non-enrolled repo names the exact enroll command', async () => {
    // Tool output is secret-scrubbed, and macOS's per-user temp dir
    // (/var/folders/xx/<32 random chars>/T) is high-entropy enough to be
    // redacted. Put the repo under a fixed low-entropy parent so the exact path
    // survives; Windows keeps the fixture home.
    const parent = process.platform === 'win32' ? null : realpathSync(mkdtempSync('/tmp/ashlr-m31-repo-'));
    try {
      const repo = join(parent ?? fx.home, 'not-enrolled');
      mkdirSync(repo, { recursive: true });
      const r = await callNativeTool('ashlr_health', { repo });
      const payload = JSON.parse(resultText(r)) as { error?: string };
      expect(payload.error).toContain(`repo not enrolled for health review: ${resolve(repo)}`);
      // Shell-quoted only when the path needs it (a Windows path has `\` and `:`).
      const arg = /^[\w@%+=:,./-]+$/u.test(resolve(repo)) ? resolve(repo) : `'${resolve(repo)}'`;
      expect(payload.error).toContain(`; enroll it with \`ashlr enroll add ${arg}\``);
    } finally {
      if (parent) rmSync(parent, { recursive: true, force: true });
    }
  });

  it('tool output still redacts a high-entropy path segment (macOS /var/folders shape)', () => {
    const segment = ['vtw8zd2j', '31d1gdrt', 'ntc5y460', '0000gn'].join('');
    const text = renderToolText({ error: `repo not enrolled: /private/var/folders/nj/${segment}/T/x/not-enrolled` });
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(segment);
  });

  it('ashlr_orient returns a valid OrientResult on empty stores', async () => {
    const r = await callNativeTool('ashlr_orient', {});
    expect(r.isError).toBeUndefined();
    const o = JSON.parse(resultText(r)) as Record<string, unknown>;
    expect(o['generatedAt']).toBeTruthy();
    expect(Array.isArray(o['genomeHits'])).toBe(true);
    expect(Array.isArray(o['backlogItems'])).toBe(true);
    expect(typeof o['pendingProposals']).toBe('number');
  });

  it('flags handler refusals ({ error }) as isError so clients do not read them as success', async () => {
    const notEnrolled = join(fx.home, 'not-enrolled');
    mkdirSync(notEnrolled, { recursive: true });
    const calls: [string, Record<string, unknown>, RegExp][] = [
      ['ashlr_health', { repo: notEnrolled }, /not enrolled/],
      ['ashlr_browser_task', { repo: notEnrolled, instructions: 'read the page', title: 't', summary: 's' }, /not enrolled/],
      ['ashlr_browser_task', { repo: notEnrolled, instructions: '   ', title: 't', summary: 's' }, /instructions must be/],
      ['ashlr_desktop_open', { repo: notEnrolled, action_type: 'open-editor', target: 'README.md', title: 't', summary: 's' }, /not enrolled/],
    ];
    for (const [name, args, reason] of calls) {
      const r = await callNativeTool(name, args);
      expect(r.isError, name).toBe(true);
      // The payload shape is unchanged: still parseable JSON with the reason.
      expect((JSON.parse(resultText(r)) as { error: string }).error).toMatch(reason);
    }
    // A successful call that merely mentions "error" text stays a success.
    const ok = await callNativeTool('ashlr_learn', { text: 'an error budget convention', title: 'errors' });
    expect(ok.isError).toBeUndefined();
  });

  it('caps oversized output with a visible truncation marker', () => {
    // Spaced prose so the scrubber's long-token patterns don't fire first.
    const text = renderToolText({ blob: 'lorem ipsum dolor sit amet '.repeat(5_000) });
    expect(text.length).toBeLessThanOrEqual(33 * 1024);
    expect(text).toContain('[ashlr: output truncated]');
  });
});

// ---------------------------------------------------------------------------
// SDK confinement (CONTRACT-M31 invariant 8)
// ---------------------------------------------------------------------------

describe('SDK confinement', () => {
  it('mcp-native.ts and orient.ts never import @modelcontextprotocol/sdk', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, '..');
    for (const rel of ['src/core/mcp-native.ts', 'src/core/orient.ts']) {
      const p = join(root, rel);
      expect(existsSync(p)).toBe(true);
      // Import statements only — prose mentions in comments are fine.
      expect(readFileSync(p, 'utf8')).not.toMatch(/from\s+['"]@modelcontextprotocol\/sdk/);
    }
  });
});
