/** Conservative PR repair: disposable object store + worktree, no direct push. */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultGitRunner } from '../verse/git-ops.js';
import { securityPinnedPath } from '../drive/queuegen.js';
import { TIER1_FLOOR_PATH_RE } from './tier1-verify.js';
import { parseConflictEntry } from './dirty-union-collect.js';
import { scrubSecrets } from '../util/scrub.js';

export const APPEND_UNION_ALLOWLIST: readonly string[] = [
  'CONTRACT.md', 'docs/README.md', 'src/cli/completions.ts', 'src/cli/help.ts',
  'notes.md', 'task_plan.md', 'notes', 'task_plan', 'docs/llms.txt',
  'test/fixtures/authority/tier1-closure.json',
];
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BUILTIN_HOLDS: Readonly<Record<string, readonly number[]>> = {
  'ashlrai/phantom': [197, 878, 743, 725, 738, 744, 693, 1228],
  'ashlrai/phantom-secrets': [140, 197, 375, 168, 418, 136],
  'ashlrai/ashlr-plugin': [152, 157],
};
const validPath = (path: string): boolean => path.length > 0 && [...path].every(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127 && ch !== '\\')
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part !== '.git');
const gated = (path: string): boolean => securityPinnedPath(path) || TIER1_FLOOR_PATH_RE.test(path)
  || /(?:secret[-_]shape|sandbox|leader.*(?:wrapper|prompt|plist)|(?:wrapper|prompt).*leader|loopback.*auth)/i.test(path);

export interface ConflictPr {
  number: number; state: string; headSha: string; headRef: string; headRepo: string; baseRef: string;
}
export interface ConflictHunk { path: string; ours: string; base: string; theirs: string }
export interface ConflictReport {
  number: number; head: string; base?: string; dryRun: boolean;
  status: 'needs-agent' | 'would-resolve' | 'ready-supersede' | 'published' | 'head-unavailable';
  reason: string; files: string[]; hunks: ConflictHunk[];
  commands: string[][]; commit?: string; bundle?: string;
  supersede?: { headRepo: string; headRef: string; base: string; publishVia: 'publish.sh'; instructions: string };
}
export interface ConflictOptions {
  repo: string; remote: string; defaultBranch: string; pr: ConflictPr; hold: ReadonlySet<string>;
  apply?: boolean; outputDir: string; allowlist?: readonly string[];
  /** Test/host seam. Production runs bounded processes with no shell and bounded logs. */
  run?: (cwd: string, argv: readonly string[]) => Promise<boolean>;
  /** Re-read live PR identity and holds immediately before publication/export. */
  refresh: () => Promise<ConflictPr | null>;
  /** Only a sanctioned publisher may implement this; absence means supersede. No git-push fallback. */
  publish?: (input: { cwd: string; pr: ConflictPr; commit: string; base: string }) => Promise<boolean>;
  /** Host-validated fork destinations supported by that publisher (not CLI supplied). */
  allowedHeadRepos?: ReadonlySet<string>;
}

/** A diff3 hunk must replace zero base lines, with nonempty insertions on both sides. */
function insertionUnion(text: string, path: string): { text: string; hunks: ConflictHunk[]; safe: boolean } {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [], hunks: ConflictHunk[] = [];
  let state: 'outside' | 'ours' | 'base' | 'theirs' = 'outside';
  let hunk: ConflictHunk = { path, ours: '', base: '', theirs: '' }, safe = true;
  for (const line of lines) {
    if (/^<<<<<<<(?: .*)?\n$/.test(line) && state === 'outside') {
      state = 'ours'; hunk = { path, ours: '', base: '', theirs: '' };
    } else if (/^\|\|\|\|\|\|\|(?: .*)?\n$/.test(line) && state === 'ours') state = 'base';
    else if (line === '=======\n' && state === 'base') state = 'theirs';
    else if (/^>>>>>>>(?: .*)?\n$/.test(line) && state === 'theirs') {
      hunks.push(hunk);
      safe &&= hunk.base === '' && hunk.ours !== '' && hunk.theirs !== '';
      // Dedupe only inserted lines in this hunk; never delete shared surrounding lines.
      out.push([...new Set([...(hunk.ours.match(/[^\n]*\n/g) ?? []), ...(hunk.theirs.match(/[^\n]*\n/g) ?? [])])].join(''));
      state = 'outside';
    } else if (/^(<{7}|\|{7}|={7}|>{7})/.test(line)) return { text, hunks, safe: false };
    else if (state === 'outside') out.push(line);
    else hunk[state] += line;
  }
  return { text: out.join(''), hunks, safe: safe && state === 'outside' && hunks.length > 0 };
}

/** Commands are not echoed: generator/verification output may contain private source. */
export async function runConflictCommand(cwd: string, argv: readonly string[]): Promise<boolean> {
  return new Promise(resolveResult => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } });
    let bytes = 0, exceeded = false;
    const kill = (): void => {
      exceeded = true;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(kill, 300_000);
    const consume = (chunk: Buffer): void => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) kill(); };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.on('error', () => { clearTimeout(timer); resolveResult(false); });
    child.on('close', code => { clearTimeout(timer); resolveResult(code === 0 && !exceeded); });
  });
}

/** Merge master into one pinned open head; all persistent writes require apply. */
export async function resolvePrConflicts(options: ConflictOptions): Promise<ConflictReport> {
  const { pr, repo } = options;
  const report: ConflictReport = { number: pr.number, head: pr.headSha, dryRun: !options.apply,
    status: 'needs-agent', reason: '', files: [], hunks: [], commands: [] };
  const refuse = (reason: string): ConflictReport => { report.reason = reason; return report; };
  const held = (hold: ReadonlySet<string>): boolean => BUILTIN_HOLDS[repo.toLowerCase()]?.includes(pr.number) === true
    || [...hold].some(key => [repo.toLowerCase(), repo.split('/')[1]!.toLowerCase()].some(name => key.toLowerCase() === `${name}#${pr.number}`));
  if (!REPO.test(repo) || !REPO.test(pr.headRepo) || !Number.isSafeInteger(pr.number) || pr.number < 1
    || !SHA.test(pr.headSha) || pr.state !== 'OPEN' || pr.baseRef !== 'master'
    || !options.defaultBranch || pr.headRef === options.defaultBranch || ['master', 'main'].includes(pr.headRef)) return refuse('invalid or default-branch PR identity');
  if (held(options.hold)) return refuse('hold-list');
  const root = await mkdtemp(join(tmpdir(), 'conflictres-'));
  const store = join(root, 'objects.git'), wt = join(root, 'worktree');
  const run = options.run ?? runConflictCommand;
  const git = async (cwd: string, args: string[], allowConflict = false): Promise<string> => {
    const result = await defaultGitRunner('git', args, { cwd, timeoutMs: 60_000, maxStdoutBytes: 8 * 1024 * 1024 });
    if (result.timedOut || result.truncated || (result.code !== 0 && !(allowConflict && result.code === 1))) {
      const verb = args.find(arg => !arg.startsWith('-') && !arg.includes('=')) ?? 'operation';
      throw new Error(`git ${verb} failed (${result.timedOut ? 'timeout' : result.truncated ? 'truncated' : result.code})`);
    }
    return result.stdout;
  };
  const command = async (argv: string[]): Promise<void> => {
    report.commands.push(argv);
    if (!await run(wt, argv)) throw new Error(`command failed: ${argv.join(' ')}`);
  };
  try {
    await mkdir(join(root, 'empty-template'));
    await git(root, ['init', '--bare', `--template=${join(root, 'empty-template')}`, store]);
    await mkdir(join(store, 'info'), { recursive: true });
    await writeFile(join(store, 'info', 'attributes'), '* merge conflict-marker-size=7\n');
    await git(root, ['check-ref-format', `refs/heads/${pr.headRef}`]);
    await git(store, ['fetch', '--no-tags', '--no-write-fetch-head', '--', options.remote,
      'refs/heads/master:refs/remotes/origin/master', `refs/pull/${pr.number}/head:refs/conflictres/head`]);
    if ((await git(store, ['rev-parse', 'refs/conflictres/head'])).trim() !== pr.headSha) return refuse('head moved');
    const base = (await git(store, ['rev-parse', 'origin/master'])).trim(); report.base = base;
    const ancestor = (await git(store, ['merge-base', '--all', base, pr.headSha])).trim();
    if (!SHA.test(ancestor)) return refuse('ambiguous merge base');
    const touched = (await git(store, ['diff', '--name-only', '--no-renames', '-z', ancestor, pr.headSha])).split('\0').filter(Boolean);
    await git(store, ['worktree', 'add', '--detach', wt, pr.headSha]);
    await git(wt, ['-c', 'merge.conflictStyle=diff3', '-c', 'merge.renormalize=false', 'merge', '--no-commit', '--no-ff', base], true);
    report.files = (await git(wt, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
    if (!report.files.length) return refuse('no content conflicts; refresh PR state');
    const entries = (await git(wt, ['ls-files', '-u', '-z'])).split('\0').filter(Boolean).map(parseConflictEntry);
    const resolved: { path: string; text: string }[] = [];
    let reason = '';
    for (const path of report.files) {
      const stages = entries.filter(entry => entry?.path === path);
      if (!validPath(path) || stages.length !== 3 || stages.some(entry => entry?.mode !== '100644')
        || new Set(stages.map(entry => entry?.stage)).size !== 3) { reason ||= 'structural or non-text conflict'; continue; }
      const text = await readFile(join(wt, path), 'utf8');
      if (/\0|\ufffd/.test(text) || text.length > 2 * 1024 * 1024) { reason ||= 'unsupported content'; continue; }
      const union = insertionUnion(text, path);
      report.hunks.push(...union.hunks.map(hunk => ({ path, ours: scrubSecrets(hunk.ours).slice(0, 4000),
        base: scrubSecrets(hunk.base).slice(0, 4000), theirs: scrubSecrets(hunk.theirs).slice(0, 4000) })));
      if (!(options.allowlist ?? APPEND_UNION_ALLOWLIST).includes(path)) reason ||= 'conflicted file outside append-union allowlist';
      if (!union.safe) reason ||= 'conflict is not a pure insertion on both sides';
      resolved.push({ path, text: union.text });
    }
    // Check the entire PR, including cleanly merged GATES edits. Tier-1 alone is not a refusal.
    if ([...touched, ...report.files].some(gated)) reason = 'GATES v3 path';
    if (reason) return refuse(reason);
    if (!options.apply) { report.status = 'would-resolve'; return refuse('append-union proven; apply required for generators, verification and export'); }
    for (const file of resolved) await writeFile(join(wt, file.path), file.text);
    await git(wt, ['add', '--', ...report.files]);
    const resolvedTree = (await git(wt, ['write-tree'])).trim();
    // Install the repository's frozen worktree dependencies only in production (fixtures inject run).
    if (!options.run) await command(['npm', 'run', 'install:worktree']);
    const outputs: string[] = [];
    if (touched.some(path => /^(src\/|test\/.*\.ts$|scripts\/)/.test(path)
      || ['.github/CODEOWNERS', 'test/fixtures/authority/tier1-closure.json'].includes(path))) {
      await command(['npm', 'run', 'authority:regen']);
      outputs.push('.github/CODEOWNERS', 'test/fixtures/authority/tier1-closure.json');
    }
    if (touched.some(path => path.startsWith('docs/'))) {
      await command(['node', 'scripts/generate-docs-llms.mjs']); outputs.push('docs/llms.txt');
    }
    // A generator may only alter its declared outputs. Stage those that exist in this repo.
    const dirty = [...new Set((await git(wt, ['diff', '--name-only', '-z'])
      + await git(wt, ['diff', '--cached', '--name-only', '-z', resolvedTree])
      + await git(wt, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean))];
    if (dirty.some(path => !outputs.includes(path))) return refuse('generator changed undeclared files');
    if (dirty.length) await git(wt, ['add', '--', ...dirty]);
    // Commit locally before verify-changed so its merge-base is master, rather than
    // linting every unrelated master change currently staged by the pending merge.
    await git(wt, ['commit', '-m', `Merge master into PR #${pr.number}: append-union conflicts`]);
    const commit = (await git(wt, ['rev-parse', 'HEAD'])).trim();
    if ((await git(wt, ['rev-list', '--parents', '-1', 'HEAD'])).trim() !== `${commit} ${pr.headSha} ${base}`) return refuse('unexpected merge parents');
    await command(['node', 'scripts/verify-changed.mjs']);
    if ((await git(wt, ['status', '--porcelain', '--untracked-files=all'])).trim()
      || (await git(wt, ['rev-parse', 'HEAD'])).trim() !== commit) return refuse('verification changed the committed tree');
    const fresh = await options.refresh();
    if (!fresh || Object.keys(pr).some(key => pr[key as keyof ConflictPr] !== fresh[key as keyof ConflictPr])) return refuse('PR identity or holds changed');
    const latest = (await git(store, ['ls-remote', '--refs', options.remote, 'refs/heads/master'])).split(/\s/)[0];
    if (latest !== base) return refuse('master moved; rerun');
    report.commit = commit;
    if (options.publish && options.allowedHeadRepos?.has(pr.headRepo)
      && pr.headRepo === `masonwyatt23/${repo.split('/')[1]}`) {
      if (await options.publish({ cwd: wt, pr, commit, base })) { report.status = 'published'; return refuse('sanctioned publisher updated the pinned PR head'); }
      // Do not retry an uncertain network write through another transport.
      return refuse('sanctioned publication unconfirmed; reconcile PR head before retry');
    }
    // publish.sh rebases a linear bundle. Export the complete verified merge tree
    // as one commit on the pinned master, rather than feeding it a merge commit.
    const tree = (await git(wt, ['rev-parse', 'HEAD^{tree}'])).trim();
    const supersede = (await git(wt, ['commit-tree', tree, '-p', base, '-m', `Supersede PR #${pr.number}: verified append-union merge`])).trim();
    await git(wt, ['switch', '--detach', supersede]);
    report.commit = supersede;
    const scratchBundle = join(root, 'resolved.bundle');
    await git(wt, ['bundle', 'create', scratchBundle, 'origin/master..HEAD']);
    await git(wt, ['bundle', 'verify', scratchBundle]);
    await mkdir(options.outputDir, { recursive: true });
    const bundle = resolve(options.outputDir, `pr-${pr.number}-${pr.headSha}.bundle`);
    await copyFile(scratchBundle, bundle, constants.COPYFILE_EXCL);
    report.bundle = bundle; report.status = 'ready-supersede';
    report.supersede = { headRepo: pr.headRepo, headRef: pr.headRef, base, publishVia: 'publish.sh',
      instructions: 'Submit bundle HEAD (one commit with the complete verified PR delta on the pinned master) as a new fleet job through publish.sh. Close the original only after the replacement PR is confirmed. Existing-head updates are unsupported by the current publisher.' };
    return refuse('verified merge; existing head has no sanctioned publish adapter');
  } catch (error) {
    return refuse(error instanceof Error && /^(?:command failed:|git \w+ failed)/.test(error.message) ? error.message : 'inspection, verification or export failed');
  } finally {
    // The object store and its linked worktree are both disposable; the source clone is never changed.
    await rm(root, { recursive: true, force: true });
  }
}
