import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditRoutes,
  auditTree,
  collectClientPaths,
  collectServerRoutes,
  isServed,
  lex,
} from '../scripts/web-route-audit.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/**
 * Desktop reads no server code answers today. Each one shows an empty or
 * "not in this build" pane (or never fetches at all). Do not add to this
 * list to go green: serve the route or delete the dead query. An entry that
 * becomes served is logged as removable, never a failure, so a job that
 * serves one can land before or after the job that drops it from here.
 */
const KNOWN_UNSERVED: readonly string[] = Object.freeze([
  // Resources > Lane usage (LaneUsagePanel): fleet-usage-source.ts ships the fixture loader until this exists.
  '/api/app/fleet-usage',
  // RepoRankPanel.tsx: the component is imported nowhere, so nothing renders it.
  '/api/repos/rank',
  // Leader thread, Feed and phone owner-channel lines (owner-thread-queries.ts). RQ-PHX-OWNERTHREADSERVE16 serves it.
  '/api/verse/comms/owner-thread',
  // Fleet inbox > CosDraftsCard: list of chief-of-staff reply drafts ("Reply approval is not in this build").
  '/api/verse/cos/drafts',
  // Fleet inbox > CosDraftsCard: the Approve button.
  '/api/verse/cos/drafts/approve',
  // Shell > Fleet needs-you rows (stuck-fixes-query.ts): any non-200 reads as "not in build".
  '/api/verse/runs-history/stuck-fixes',
]);

/**
 * Served, but by dispatch the audit cannot read statically. Each entry names
 * where the server answers it.
 */
const SERVED_BY_DYNAMIC: readonly string[] = Object.freeze([
  // src/core/verse/verse-api.ts:1632 CONTEXT_ROUTE_METHODS keys, dispatched at :2181 via contextRouteOf(path).
  '/api/verse/context-fit',
  '/api/verse/memory',
  '/api/verse/preferences',
  '/api/verse/search',
]);

const src = (file: string, text: string) => ({ file, text });

describe('web route audit: the real tree', () => {
  it('every desktop /api read is served, dynamic or a known gap', () => {
    const started = process.cpuUsage();
    const { unserved, served } = auditTree(REPO);
    const cpu = process.cpuUsage(started);
    // Budget is 2 s; CPU time, not wall time, so a loaded machine cannot flake it.
    expect((cpu.user + cpu.system) / 1000).toBeLessThan(2000);
    expect(served).toBeGreaterThan(100);

    const allowed = new Set([...KNOWN_UNSERVED, ...SERVED_BY_DYNAMIC]);
    const fresh = unserved.filter(({ path }) => !allowed.has(path));
    const message = [
      'Desktop panes read API routes no server code serves:',
      ...fresh.map(({ path, files }) => `  ${path}  <- ${files.join(', ')}`),
      'Serve the route or delete the dead query. Only a route the server answers through',
      'dispatch the audit cannot see belongs in SERVED_BY_DYNAMIC, with its file:line.',
    ].join('\n');
    expect(fresh, message).toEqual([]);

    const stillUnserved = new Set(unserved.map(({ path }) => path));
    const removable = [...KNOWN_UNSERVED, ...SERVED_BY_DYNAMIC].filter((path) => !stillUnserved.has(path));
    if (removable.length > 0) {
      console.info(`web-route-audit: now served or no longer read, remove from the allow-lists:\n  ${removable.join('\n  ')}`);
    }
  });
});

describe('web route audit: matcher', () => {
  const server = collectServerRoutes([
    src('src/core/verse/a-api.ts', [
      "export const VERSE_A_PATH = '/api/verse/a';",
      "if (path === '/api/verse/exact' && method === 'GET') {}",
      "if (url.pathname.startsWith('/api/run/')) {}",
      'const m = /^\\/api\\/job\\/([a-z0-9-]+)\\/(list|read)$/.exec(path);',
    ].join('\n')),
  ]);

  it('matches an exact literal and an exported *_PATH constant', () => {
    expect(isServed('/api/verse/exact', server)).toBe(true);
    expect(isServed('/api/verse/a', server)).toBe(true);
    expect(isServed('/api/verse/exact/more', server)).toBe(false);
  });

  it('matches a startsWith prefix', () => {
    expect(isServed('/api/run/123/events', server)).toBe(true);
    expect(isServed('/api/runs', server)).toBe(false);
  });

  it('matches a route regex, including through template holes', () => {
    expect(isServed('/api/job/abc/list', server)).toBe(true);
    expect(isServed('/api/job/:param/:param', server)).toBe(true);
    expect(isServed('/api/job/abc/delete', server)).toBe(false);
  });

  it('normalises template holes to :param and strips query strings', () => {
    const client = collectClientPaths([
      src('src/web-ui/q.ts', [
        "const BASE = '/api/verse/base';",
        'apiGet(`/api/verse/sessions/${encodeURIComponent(id)}/turns`);',
        "apiGet('/api/verse/exact?limit=5');",
        'apiGet(`/api/verse/exact?since=${since}`);',
        'apiGet(`${BASE}/child`);',
      ].join('\n')),
    ]).map(({ path }) => path);
    expect(client).toEqual(['/api/verse/base', '/api/verse/base/child', '/api/verse/exact', '/api/verse/sessions/:param/turns']);
    expect(isServed('/api/verse/exact', server)).toBe(true);
  });

  it('a hole matches any one server segment, and vice versa', () => {
    const holes = collectServerRoutes([src('src/core/verse/b.ts', "const P = `/api/verse/s/${id}/x`; if (path === P) {}")]);
    expect(holes.literals).toEqual(['/api/verse/s/:param/x']);
    expect(isServed('/api/verse/s/abc/x', holes)).toBe(true);
    expect(isServed('/api/verse/s/:param/x', holes)).toBe(true);
    expect(isServed('/api/verse/s/abc/y', holes)).toBe(false);
  });

  it('resolves constants across files and reads family prefixes on a segment boundary', () => {
    const routes = collectServerRoutes([
      src('src/core/verse/workbench-types.ts', "export const F = [{ id: 'git', prefixes: ['/api/verse/git'] }];"),
      src('src/core/verse/types.ts', "export const ROOT = '/api/verse';"),
      src('src/core/verse/c.ts', 'const sessions = `${ROOT}/sessions/`;\nif (path.startsWith(sessions)) {}'),
    ]);
    expect(isServed('/api/verse/git', routes)).toBe(true);
    expect(isServed('/api/verse/git/status', routes)).toBe(true);
    expect(isServed('/api/verse/github', routes)).toBe(false);
    expect(isServed('/api/verse/sessions/:param', routes)).toBe(true);
  });

  it('ignores comments, prose and division', () => {
    const { literals } = lex("const a = b / c; // '/api/in-comment'\n/* '/api/block' */ const r = /x'y/g;");
    expect(literals).toEqual([{ kind: 'regex', source: "x'y", flags: 'g' }]);
    const client = collectClientPaths([src('src/web-ui/p.ts', "const msg = '/api/control did not answer';")]);
    expect(client).toEqual([]);
  });

  it('auditRoutes counts served paths and lists unserved ones with their files', () => {
    const result = auditRoutes(
      [{ path: '/api/verse/exact', files: ['a.ts'] }, { path: '/api/verse/nope', files: ['b.ts', 'c.ts'] }],
      server,
    );
    expect(result).toEqual({ served: 1, unserved: [{ path: '/api/verse/nope', files: ['b.ts', 'c.ts'] }] });
  });
});

describe('web route audit: a tree with a dead read', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it('names the unserved path and the client file, and follows mounted route modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'web-route-audit-'));
    roots.push(root);
    const files: Record<string, string> = {
      'src/web-ui/pane.ts': "apiGet('/api/verse/nope'); apiGet('/api/verse/mounted'); apiGet('/api/verse/live');",
      'src/web-ui/pane.test.ts': "apiGet('/api/verse/only-in-a-test');",
      'src/core/verse/verse-api.ts': "const load = () => import('../elsewhere/mounted-api.js');\nif (path === '/api/verse/live') {}",
      'src/core/elsewhere/mounted-api.ts': "import { MOUNTED } from './types.js';\nif (path === MOUNTED) {}",
      'src/core/elsewhere/types.ts': "export const MOUNTED = '/api/verse/mounted';",
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    expect(auditTree(root)).toEqual({ served: 2, unserved: [{ path: '/api/verse/nope', files: ['src/web-ui/pane.ts'] }] });
  });
});
