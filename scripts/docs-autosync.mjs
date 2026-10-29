#!/usr/bin/env node
/**
 * scripts/docs-autosync.mjs - the docs-autosync daily-run step.
 *
 * One command regenerates every reference doc this repository generates from
 * source, so the docs a reader sees can never drift from the checkout they
 * describe:
 *
 *   docs/cli.md               phm --help + phm help --all   scripts/generate-cli-docs.mjs
 *   docs/CLI-REFERENCE.md     phm --help + phm help --all   scripts/generate-cli-reference.ts
 *   docs/CONFIG-REFERENCE.md  schema/config.schema.json     scripts/generate-config-docs.mjs
 *
 *   node scripts/docs-autosync.mjs            rewrite any stale generated doc in place
 *   node scripts/docs-autosync.mjs --check    compare only; exit 1 naming stale docs
 *   node scripts/docs-autosync.mjs --list     print the managed doc paths, one per line
 *   node scripts/docs-autosync.mjs --json     machine-readable status instead of text
 *
 * Scheduling and publication stay with the existing sanctioned path: a daily
 * bridge/router-queue job runs the bare command in a master worktree after
 * each merge window, and the resulting diff lands through a normal PR — the
 * same way every bridge job ships. This script never commits, pushes, opens
 * PRs or touches credentials itself; when no doc drifts it is a no-op.
 * See docs/DOCS-AUTOSYNC.md for the job contract.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHILD_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Run a generated-doc subprocess and normalize its outcome to a status word. */
function runChild(argv, { repoRoot, check }) {
  const result = spawnSync(process.execPath, [...argv, ...(check ? ['--check'] : [])], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error) return { status: 'error', detail: result.error.message };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status === 0) return { status: check ? 'fresh' : 'written' };
  return { status: /drift|stale/i.test(output) ? 'stale' : 'error', detail: output.trim().slice(0, 500) };
}

/**
 * Each target owns one generated file and knows how to check it byte-for-byte
 * and rewrite it in place. docs/CLI-REFERENCE.md delegates to its TypeScript
 * generator through a child process; the .mjs generators run in-process.
 */
export const DOC_TARGETS = [
  {
    path: 'docs/cli.md',
    async status(repoRoot) {
      const { checkCliDocs } = await import('./generate-cli-docs.mjs');
      return { status: checkCliDocs(repoRoot).ok ? 'fresh' : 'stale' };
    },
    async write(repoRoot) {
      const { buildCliDocs } = await import('./generate-cli-docs.mjs');
      writeFileSync(join(repoRoot, 'docs/cli.md'), buildCliDocs({ repoRoot }));
    },
  },
  {
    path: 'docs/CLI-REFERENCE.md',
    async status(repoRoot) {
      let tsxLoader;
      try {
        tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      } catch {
        return { status: 'error', detail: 'tsx is required to run generate-cli-reference.ts; run `npm ci` first' };
      }
      return runChild(['--import', tsxLoader, 'scripts/generate-cli-reference.ts'], { repoRoot, check: true });
    },
    async write(repoRoot) {
      const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = runChild(['--import', tsxLoader, 'scripts/generate-cli-reference.ts'], { repoRoot, check: false });
      if (result.status === 'error') throw new Error(result.detail);
    },
  },
  {
    path: 'docs/CONFIG-REFERENCE.md',
    async status(repoRoot) {
      const { checkConfigDocs } = await import('./generate-config-docs.mjs');
      return { status: checkConfigDocs(repoRoot).ok ? 'fresh' : 'stale' };
    },
    async write(repoRoot) {
      const { buildConfigDocs } = await import('./generate-config-docs.mjs');
      writeFileSync(join(repoRoot, 'docs/CONFIG-REFERENCE.md'), buildConfigDocs({ repoRoot }));
    },
  },
];

/** Check every managed doc; never writes. One error cannot hide the others. */
export async function statusDocs(repoRoot = REPO_ROOT, targets = DOC_TARGETS) {
  const docs = [];
  for (const target of targets) {
    try {
      docs.push({ path: target.path, ...(await target.status(repoRoot)) });
    } catch (error) {
      docs.push({ path: target.path, status: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return docs;
}

/** Rewrite every stale managed doc in place; returns per-doc status. */
export async function syncDocs(repoRoot = REPO_ROOT, targets = DOC_TARGETS) {
  const docs = [];
  for (const target of targets) {
    try {
      const { status, detail } = await target.status(repoRoot);
      if (status === 'fresh') docs.push({ path: target.path, status });
      else if (status === 'stale') {
        await target.write(repoRoot);
        docs.push({ path: target.path, status: 'written' });
      } else docs.push({ path: target.path, status, detail });
    } catch (error) {
      docs.push({ path: target.path, status: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return docs;
}

const USAGE = `usage: node scripts/docs-autosync.mjs [--check|--list] [--json]
  (no args) rewrite stale generated reference docs in place
  --check   compare only; exit 1 when any managed doc is stale or errors
  --list    print the managed doc paths, one per line
  --json    print machine-readable status instead of text`;

export function main(args, repoRoot = REPO_ROOT) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const known = new Set(['--check', '--list', '--json']);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0 || (args.includes('--check') && args.includes('--list'))) {
    console.error(`invalid arguments: ${unknown[0] ?? '--check with --list'}`);
    console.error(USAGE);
    return 2;
  }
  const json = args.includes('--json');
  if (args.includes('--list')) {
    for (const target of DOC_TARGETS) console.log(target.path);
    return 0;
  }
  const check = args.includes('--check');
  return (check ? statusDocs(repoRoot) : syncDocs(repoRoot)).then((docs) => {
    const ok = docs.every((doc) => doc.status === 'fresh' || doc.status === 'written');
    if (json) {
      console.log(JSON.stringify({ ok, mode: check ? 'check' : 'sync', docs }, null, 2));
    } else {
      const width = Math.max(...docs.map((doc) => doc.path.length));
      for (const doc of docs) {
        const suffix = doc.detail ? ` - ${doc.detail}` : '';
        console.log(`${doc.path.padEnd(width)}  ${doc.status}${suffix}`);
      }
      if (ok) {
        console.log(check ? 'all generated docs are up to date.' : 'generated docs are in sync; commit any diff through a normal PR.');
      } else {
        console.error(check
          ? 'generated docs drifted; run `node scripts/docs-autosync.mjs` to regenerate.'
          : 'some generated docs could not be synced; see errors above.');
      }
    }
    return ok ? 0 : 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve(main(process.argv.slice(2))).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`docs-autosync: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
