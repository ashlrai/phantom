/**
 * `phm devin land` (src/core/devin/land.ts): a fake Devin API serves a real
 * bundle + pr.md made in temp git repos; a stub publish.sh stands in for the
 * pinned publisher. Nothing touches the real home, GitHub or Devin.
 */
import { execFileSync, execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDevinCli, type DevinCliDeps } from '../src/cli/devin.js';
import { DevinClient, type DevinSessionAttachment } from '../src/core/devin/client.js';
import {
  autoMergeDecision, DEVIN_LAND_LEDGER_FILE, landDevinSession, parsePrMd, parsePublishResult,
  type CommandRunner, type DevinLandApi, type DevinLandResult,
} from '../src/core/devin/land.js';
import { devinHome } from '../src/core/devin/store.js';
import { runDevinAutoland } from '../src/core/devin/autoland.js';

const SESSION = 'devin-0123456789abcdef0123456789abcdef';
const JOB = 'DEVIN-0123456789ab';
const PR_URL = 'https://github.com/ashlrai/phantom/pull/4242';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=master', ...args], {
    cwd, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: cwd },
  }).trim();
}

const STUB_PUBLISH = `#!/bin/bash
J=$1; R=~/.ashlr-runs; OUT=$R/$J.publish; exec >"$OUT" 2>&1
read BASE BR WT POOL < $R/$J.base
IFS=$'\\t' read -r LJ NAME LANE TIER PROMPT < "$R/queue/run/$J.line"
[ "$LJ" = "$J" ] || { echo "RESULT ABORT job-record-mismatch"; exit 1; }
case "$NAME" in phantom|phantom-secrets|ashlr-plugin|locus|lexicon|ashlr-md|ashlr-stack) ;; *) echo "RESULT ABORT repo-not-allowlisted"; exit 1;; esac
cd "$WT" || { echo "RESULT ABORT no-wt"; exit 1; }
CMN=$(cd -P -- "$(git rev-parse --git-common-dir)" && pwd -P); EXP=$(cd -P -- "$HOME/Projects/ashlrai/$NAME/.git" && pwd -P)
[ "$CMN" = "$EXP" ] || { echo "RESULT ABORT repo-mismatch"; exit 1; }
echo "STUB lane=$LANE tier=$TIER branch=$(git rev-parse --abbrev-ref HEAD) br=$BR pool=$POOL"
echo "STUB base=$BASE count=$(git rev-list --count $BASE..HEAD) notes=$(head -1 BRIDGE_NOTES.md)"
echo "\${STUB_AUTO_MERGE_LINE:-NOTE AUTO_MERGE skipped-or-failed}"
HEAD_LINE=" HEADSHA=$(git rev-parse HEAD)"
[ "\${STUB_PUBLISH_NO_HEAD:-0}" != "1" ] || HEAD_LINE=""
echo "RESULT PR \${STUB_PR_URL:-${PR_URL}}$HEAD_LINE SENS=[\${STUB_SENS:-}]"
`;

interface World {
  home: string;
  origin: string;
  host: string;
  bundle: Buffer;
  prMd: Buffer;
  sessionTip: string;
  calls: string[];
  gh: string[][];
  api: DevinLandApi;
  run: CommandRunner;
}

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'devin-land-')); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

function world(opts: { conflict?: boolean; attachments?: (w: { bundle: Buffer; prMd: Buffer }) => DevinSessionAttachment[]; bundle?: Buffer } = {}): World {
  const home = join(scratch, 'home');
  const origin = join(scratch, 'origin.git');
  const seed = join(scratch, 'seed');
  const session = join(scratch, 'session');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Host\n\temail = host@example.com\n');
  git(scratch, 'init', '-q', '--bare', origin);
  git(scratch, 'clone', '-q', origin, seed);
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'push', '-q', 'origin', 'HEAD:master');
  // The Devin session: two commits of its own on the master it cloned.
  git(scratch, 'clone', '-q', origin, session);
  writeFileSync(join(session, 'feature.txt'), 'feature\n');
  git(session, 'add', '.');
  git(session, 'commit', '-qm', 'feat: add feature');
  writeFileSync(join(session, opts.conflict ? 'a.txt' : 'feature.txt'), 'feature two\n');
  git(session, 'commit', '-qam', 'feat: refine feature');
  git(session, 'bundle', 'create', '-q', join(scratch, 's.bundle'), 'origin/master..HEAD');
  const sessionTip = git(session, 'rev-parse', 'HEAD');
  // Host checkout, cloned before master moved on; land must fetch the newer master.
  const host = join(home, 'Projects', 'ashlrai', 'phantom');
  git(scratch, 'clone', '-q', origin, host);
  writeFileSync(join(seed, 'a.txt'), 'one\nmoved on\n');
  git(seed, 'commit', '-qam', 'main moves');
  git(seed, 'push', '-q', 'origin', 'HEAD:master');
  mkdirSync(join(home, '.ashlr-runs', 'bin'), { recursive: true });
  writeFileSync(join(home, '.ashlr-runs', 'bin', 'publish.sh'), STUB_PUBLISH);
  chmodSync(join(home, '.ashlr-runs', 'bin', 'publish.sh'), 0o755);

  const bundle = opts.bundle ?? readFileSync(join(scratch, 's.bundle'));
  const prMd = Buffer.from('# Add the feature\n\nBody line one.\nBody line two.\n');
  const calls: string[] = [];
  const attachments = opts.attachments?.({ bundle, prMd }) ?? [
    { attachmentId: 'a1', name: 'feature.bundle', url: 'https://app.devin.ai/attachments/u-bundle/feature.bundle', source: 'devin', contentType: null },
    { attachmentId: 'a2', name: 'feature.pr.md', url: 'https://app.devin.ai/attachments/u-pr/feature.pr.md', source: 'devin', contentType: 'text/markdown' },
    { attachmentId: 'a3', name: 'notes.bundle', url: 'https://app.devin.ai/attachments/u-user/notes.bundle', source: 'user', contentType: null },
  ];
  const api: DevinLandApi = {
    getSession: async (org, id) => { calls.push(`getSession ${org} ${id}`); return { url: `https://app.devin.ai/sessions/${id}`, title: 'Feature', status: 'exit' } as never; },
    listSessionAttachments: async (org, id) => { calls.push(`list ${org} ${id}`); return attachments; },
    downloadAttachment: async (org, uuid, name) => {
      calls.push(`download ${org} ${uuid} ${name}`);
      if (uuid === 'u-bundle') return bundle;
      if (uuid === 'u-pr') return prMd;
      throw new Error(`unexpected attachment ${uuid}`);
    },
  };
  const gh: string[][] = [];
  const run: CommandRunner = (cmd, args, o) => {
    if (cmd === 'gh') { gh.push([...args]); return Promise.resolve({ code: 0, stdout: '', stderr: '' }); }
    return new Promise((resolve) => execFile(cmd, [...args], { cwd: o.cwd, env: { ...o.env, ...stubEnv }, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0, stdout, stderr });
    }));
  };
  return { home, origin, host, bundle, prMd, sessionTip, calls, gh, api, run };
}

let stubEnv: Record<string, string> = {};
beforeEach(() => { stubEnv = {}; });

function land(w: World, apply: boolean, extra: Partial<Parameters<typeof landDevinSession>[0]> = {}): Promise<DevinLandResult> {
  return landDevinSession({ sessionId: SESSION, apply, ...extra }, {
    home: w.home, run: w.run, api: async () => ({ client: w.api, orgId: 'org-test' }), now: () => new Date('2026-11-17T08:00:00Z'),
  });
}

const ledgerPath = () => join(devinHome(), DEVIN_LAND_LEDGER_FILE);

describe('devin land', () => {
  it('autoland applies a real git bundle through the stub publisher', async () => {
    const w = world();
    vi.stubEnv('ASHLR_HOME', join(w.home, '.ashlr'));
    try {
      const session = { sessionId: SESSION, serviceUserId: 'ours', status: 'exit', isArchived: false } as never;
      const result = await runDevinAutoland({ apply: true }, {
        home: w.home, killActive: () => false,
        api: async () => ({ orgId: 'org-test', client: {
          getSelf: async () => ({ principal: 'service_user', name: null, orgId: 'org-test', identity: { principal: 'service_user', serviceUserId: 'ours', userId: null, apiKeyId: null, orgId: null, devinSessionsOrgId: null } }),
          listSessions: async () => ({ items: [session], endCursor: null, hasNextPage: false }),
          listSessionAttachments: w.api.listSessionAttachments,
          terminateSession: async () => session, archiveSession: async () => session,
        } }),
        land: req => landDevinSession(req, { home: w.home, run: w.run, api: async () => ({ client: w.api, orgId: 'org-test' }) }),
      });
      expect(result).toMatchObject({ ok: true, landed: 1 });
      expect(result.decisions[0]).toMatchObject({ decision: 'landed', commitCount: 2, pr: PR_URL });
      expect(result.decisions.at(-1)?.decision).toBe('archived');
    } finally { vi.unstubAllEnvs(); }
  });
  it('dry run verifies the bundle, finds the session commits, and writes nothing', async () => {
    const w = world();
    const result = await land(w, false);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, mode: 'dry-run', repo: 'phantom', job: JOB, commitCount: 2, prMd: { title: 'Add the feature' } });
    expect(result.commits?.map((c) => c.subject)).toEqual(['feat: add feature', 'feat: refine feature']);
    expect(result.bundle?.tip).toBe(w.sessionTip);
    expect(result.steps.join('\n')).toContain('git rebase --onto origin/master HEAD~2');
    expect(w.calls).toEqual([
      `getSession org-test ${SESSION}`, `list org-test ${SESSION}`,
      'download org-test u-bundle feature.bundle', 'download org-test u-pr feature.pr.md',
    ]);
    const runs = join(w.home, '.ashlr-runs');
    expect(existsSync(join(runs, 'queue'))).toBe(false);
    expect(existsSync(join(runs, `${JOB}.publish`))).toBe(false);
    expect(existsSync(join(w.home, 'Projects', 'ashlrai', 'wt'))).toBe(false);
    expect(existsSync(ledgerPath())).toBe(false);
    expect(w.gh).toEqual([]);
    expect(() => git(w.host, 'rev-parse', '--verify', '-q', `refs/heads/codex-bridge/${JOB}`)).toThrow();
  });

  it('apply rebases onto the latest origin, writes the records, publishes, arms auto-merge and records the landing', async () => {
    const w = world();
    const result = await land(w, true);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, mode: 'apply', commitCount: 2, publish: { pr: PR_URL, sens: '' }, autoMerge: { armed: true } });
    const latest = git(w.origin, 'rev-parse', 'master');
    expect(result.base?.sha).toBe(latest);
    const runs = join(w.home, '.ashlr-runs');
    const wt = join(w.home, 'Projects', 'ashlrai', 'wt', JOB);
    expect(readFileSync(join(runs, 'queue', 'run', `${JOB}.line`), 'utf8')).toBe(`${JOB}\tphantom\tdevin\tfrontier\tLand Devin session ${SESSION}: Add the feature\n`);
    expect(readFileSync(join(runs, `${JOB}.base`), 'utf8')).toBe(`${latest} codex-bridge/${JOB} ${wt} devin\n`);
    expect(readFileSync(join(runs, `${JOB}.body.md`), 'utf8')).toBe('Body line one.\nBody line two.\n');
    const log = readFileSync(join(runs, `${JOB}.publish`), 'utf8');
    expect(log).toContain(`STUB lane=devin tier=frontier branch=codex-bridge/${JOB} br=codex-bridge/${JOB} pool=devin`);
    expect(log).toContain(`STUB base=${latest} count=2 notes=Add the feature`);
    // The session's commits now sit on the moved-on master, content intact.
    expect(git(wt, 'merge-base', 'HEAD', latest)).toBe(latest);
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('one\nmoved on\n');
    expect(readFileSync(join(wt, 'feature.txt'), 'utf8')).toBe('feature two\n');
    expect(w.gh).toEqual([['pr', 'merge', PR_URL, '--repo', 'ashlrai/phantom', '--auto', '--squash', '--match-head-commit', git(wt, 'rev-parse', 'HEAD')]]);
    const ledger = readFileSync(ledgerPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: 'devin-land', sessionId: SESSION, repo: 'ashlrai/phantom', job: JOB, commits: 2, pr: PR_URL, base: latest, tip: w.sessionTip });
    // A second apply for the same job is refused before anything is downloaded.
    w.calls.length = 0;
    const again = await land(w, true);
    expect(again.ok).toBe(false);
    expect(again.error).toContain('already has a worktree');
    expect(w.calls).toEqual([]);
  });

  it('leaves auto-merge off when publish.sh withheld it, and on sensitive paths', async () => {
    stubEnv = { STUB_AUTO_MERGE_LINE: 'NOTE AUTO_MERGE skipped judge (leader review)' };
    const w = world();
    const result = await land(w, true);
    expect(result).toMatchObject({ ok: true, autoMerge: { armed: false, detail: 'NOTE AUTO_MERGE skipped judge (leader review)' } });
    expect(w.gh).toEqual([]);
    expect(autoMergeDecision('RESULT PR x', 'scrub.pl')).toMatchObject({ arm: false });
    expect(autoMergeDecision('NOTE AUTO_MERGE deferred (x); arm_gate.py sweep re-evaluates', '')).toMatchObject({ arm: false });
    expect(autoMergeDecision('AUTO_MERGE on (squash fallback)', '')).toEqual({ arm: false, detail: 'already armed by publish.sh' });
    expect(autoMergeDecision('NOTE AUTO_MERGE skipped-or-failed', '')).toMatchObject({ arm: true });
  });

  it('refuses fallback auto-merge when the publisher does not report a head SHA', async () => {
    stubEnv = { STUB_PUBLISH_NO_HEAD: '1' };
    const w = world();
    const result = await land(w, true);
    expect(result.autoMerge).toEqual({
      armed: false,
      detail: 'arm-refused: publish result head SHA is unknown; left for the next guarded pass.',
      reasonCode: 'arm-refused',
    });
    expect(w.gh).toEqual([]);
  });

  it('reports a publish.sh abort without arming auto-merge', async () => {
    stubEnv = { STUB_PR_URL: 'https://github.com/someone/else/pull/1' };
    const w = world();
    const result = await land(w, true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('publish.sh did not open a PR');
    expect(w.gh).toEqual([]);
    expect(readFileSync(ledgerPath(), 'utf8')).toContain('"pr":null');
  });

  it('refuses repos outside the publish.sh allowlist before any API call', async () => {
    const w = world();
    for (const repo of ['ashlr-hub', 'someone/phantom', 'ashlrai/../phantom']) {
      const result = await land(w, true, { repo });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("publish.sh's allowlist");
    }
    expect(w.calls).toEqual([]);
    expect((await land(w, false, { repo: 'ashlrai/phantom' })).ok).toBe(true);
  });

  it('refuses a corrupt bundle', async () => {
    const w = world({ bundle: Buffer.from('# v2 git bundle\nnot really\n') });
    const result = await land(w, false);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/git bundle verify failed|bundle carries no refs/);
  });

  it('requires both attachments from Devin, not the user', async () => {
    const w = world({ attachments: () => [
      { attachmentId: 'a1', name: 'feature.bundle', url: 'https://app.devin.ai/attachments/u-bundle/feature.bundle', source: 'devin', contentType: null },
      { attachmentId: 'a2', name: 'feature.pr.md', url: 'https://app.devin.ai/attachments/u-pr/feature.pr.md', source: 'user', contentType: null },
    ] });
    const result = await land(w, false);
    expect(result.error).toBe('The session attached no feature.pr.md.');
  });

  it('removes the worktree and branch when the commits do not rebase cleanly', async () => {
    const w = world({ conflict: true });
    const result = await land(w, true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('do not rebase cleanly');
    expect(existsSync(join(w.home, 'Projects', 'ashlrai', 'wt', JOB))).toBe(false);
    expect(() => git(w.host, 'rev-parse', '--verify', '-q', `refs/heads/codex-bridge/${JOB}`)).toThrow();
    expect(existsSync(join(w.home, '.ashlr-runs', `${JOB}.publish`))).toBe(false);
  });

  it('parses pr.md and publish results strictly', () => {
    expect(parsePrMd('\n# Title here\n\nBody\n')).toEqual({ title: 'Title here', body: 'Body' });
    expect(parsePrMd('  \n')).toBeNull();
    expect(parsePublishResult(`TEST ok\nRESULT PR ${PR_URL} SENS=[]\n`, 'phantom')).toEqual({ result: `RESULT PR ${PR_URL}`, pr: PR_URL, sens: '', headSha: null });
    expect(parsePublishResult(`RESULT PR ${PR_URL} HEADSHA=${'a'.repeat(40)} SENS=[]`, 'phantom').headSha).toBe('a'.repeat(40));
    expect(parsePublishResult(`RESULT PR ${PR_URL} SENS=[ scrub.pl ]`, 'phantom').sens).toBe('scrub.pl');
    expect(parsePublishResult('RESULT ABORT push', 'phantom')).toEqual({ result: 'RESULT ABORT push', pr: null, sens: '', headSha: null });
    expect(parsePublishResult(`RESULT PR ${PR_URL}`, 'locus').pr).toBeNull();
  });
});

describe('DevinClient attachments', () => {
  const KEY = 'cog_landTestKey_abcdefghijklmnopqrstuvwxyz';
  it('lists attachments and downloads through the redirect without sending the key onward', async () => {
    const seen: Array<{ url: string; auth: string | undefined; redirect: string | undefined }> = [];
    const client = new DevinClient({
      apiKey: KEY,
      fetch: async (url, init) => {
        seen.push({ url, auth: init.headers['Authorization'], redirect: init.redirect });
        const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
        if (url.endsWith('/sessions/' + SESSION + '/attachments')) {
          return { status: 200, headers: headers({}), text: async () => JSON.stringify([{ attachment_id: 'x', name: 'f.bundle', url: 'https://app.devin.ai/attachments/u1/f.bundle', source: 'devin' }]) };
        }
        if (url.includes('/attachments/u1/')) return { status: 307, headers: headers({ location: 'https://s3.example.com/obj?sig=1' }), text: async () => '' };
        return new Response('BUNDLE', { status: 200 });
      },
    });
    expect(await client.listSessionAttachments('org-1', SESSION)).toEqual([{ attachmentId: 'x', name: 'f.bundle', url: 'https://app.devin.ai/attachments/u1/f.bundle', source: 'devin', contentType: null }]);
    expect((await client.downloadAttachment('org-1', 'u1', 'f.bundle', 100)).toString()).toBe('BUNDLE');
    expect(seen[1]).toEqual({ url: 'https://api.devin.ai/v3/organizations/org-1/attachments/u1/f.bundle', auth: `Bearer ${KEY}`, redirect: 'manual' });
    expect(seen[2]).toEqual({ url: 'https://s3.example.com/obj?sig=1', auth: undefined, redirect: 'manual' });
    await expect(client.downloadAttachment('org-1', 'u1', 'f.bundle', 3)).rejects.toThrow('larger than allowed');
    await expect(client.downloadAttachment('org-1', '../x', 'f.bundle', 3)).rejects.toThrow('not a Devin attachment');
  });

  it('downloads listed names with spaces, Unicode and non-traversal consecutive dots as one path segment', async () => {
    const names = ['file with spaces.bundle', 'résumé..bundle'];
    const seen: string[] = [];
    const client = new DevinClient({
      apiKey: KEY,
      fetch: async url => {
        const path = String(url);
        seen.push(path);
        if (path.endsWith(`/sessions/${SESSION}/attachments`)) {
          return new Response(JSON.stringify(names.map((name, index) => ({
            attachment_id: `a${index}`, name, url: 'https://app.devin.ai/attachments/u1', source: 'devin',
          }))));
        }
        return new Response('BUNDLE');
      },
    });

    const attachments = await client.listSessionAttachments('org-1', SESSION);
    expect(attachments.map(attachment => attachment.name)).toEqual(names);
    for (const attachment of attachments) {
      await client.downloadAttachment('org-1', 'u1', attachment.name, 100);
    }
    expect(seen.slice(1)).toEqual([
      'https://api.devin.ai/v3/organizations/org-1/attachments/u1/file%20with%20spaces.bundle',
      'https://api.devin.ai/v3/organizations/org-1/attachments/u1/r%C3%A9sum%C3%A9..bundle',
    ]);

    for (const name of ['..', '../escape.bundle', 'folder/name.bundle', 'folder\\name.bundle', 'file\0.bundle']) {
      await expect(client.downloadAttachment('org-1', 'u1', name, 100)).rejects.toMatchObject({ code: 'invalid-request' });
    }
    expect(seen).toHaveLength(3);
  });
});

describe('ashlr devin land (CLI)', () => {
  it('parses flags, defaults to a dry run, and redacts keys', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const seen: unknown[] = [];
    const deps = {
      land: async (req: unknown) => { seen.push(req); return { v: 1, ok: false, mode: 'dry-run', sessionId: SESSION, repo: 'phantom', job: JOB, steps: [], error: 'no cog_secretKey_abcdef here' } as DevinLandResult; },
      out: (l: string) => out.push(l), err: (l: string) => err.push(l),
    } as Partial<DevinCliDeps>;
    expect(await runDevinCli(['land', '--session', SESSION, '--repo', 'phantom', '--json'], deps)).toBe(1);
    expect(seen[0]).toEqual({ sessionId: SESSION, apply: false, repo: 'phantom' });
    expect(out.join('\n')).toContain('[REDACTED]');
    expect(out.join('\n')).not.toContain('cog_secretKey');
    expect(await runDevinCli(['land', '--session', SESSION, '--apply', '--job', 'J1'], deps)).toBe(1);
    expect(seen[1]).toEqual({ sessionId: SESSION, apply: true, job: 'J1' });
    expect(err.join('\n')).toContain('Not landed: no [REDACTED] here');
    expect(await runDevinCli(['land'], deps)).toBe(2);
    expect(await runDevinCli(['land', '--session', SESSION, '--force'], deps)).toBe(2);
    expect(await runDevinCli(['land', '--help'], deps)).toBe(0);
    expect(seen).toHaveLength(2);
  });
});
