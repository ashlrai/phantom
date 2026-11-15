import { configureReleaseArticles, defaultReleaseArticlesDeps, importProposedRelease, readReleaseArticles, syncReleaseArticles, type ReleaseArticlesDeps } from '../core/release-articles.js';
import { readPrivateFileCapped } from '../core/verse/preferences.js';
import { verifyLatestWorkbenchRelease } from '../core/release-public-facts.js';
import { execFileSync } from 'node:child_process';

export const RELEASE_ARTICLES_USAGE = 'phm release-articles status | metadata | gap | enable [ashlrai/ashlr-hub|ashlrai/phantom] | disable | import <proposed.json> | sync [version] [--json]';

/** First-parent history includes squash merges, as used by this repository. */
export async function releaseGapReport(directory = process.cwd(), signal?: AbortSignal, latestVersion?: string): Promise<{
  version: string; tag: string; head: string; groups: Record<string, { sha: string; subject: string }[]>;
}> {
  let version = latestVersion;
  if (version === undefined) {
    const response = await fetch('https://registry.npmjs.org/%40ashlr%2Fphantom/latest', {
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    });
    if (!response.ok || !response.body) throw new Error('npm version unavailable');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length; if (size > 1024 * 1024) throw new Error('npm response too large');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const metadata: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!metadata || typeof metadata !== 'object' || !('name' in metadata) || metadata.name !== '@ashlr/phantom' || !('version' in metadata) || typeof metadata.version !== 'string') throw new Error('Invalid npm metadata');
    version = metadata.version;
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid npm version');
  const tag = `v${version}`;
  const git = (args: string[]): string => execFileSync('git', args, { cwd: directory, encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const release = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).trim();
  const history = git(['rev-list', '--first-parent', head]).trim().split('\n');
  if (!history.includes(release)) throw new Error('Published tag is not on first-parent history');
  const entries = git(['log', '--first-parent', '--format=%H%x00%s%x00', `${release}..${head}`]).split('\0');
  const groups: Record<string, { sha: string; subject: string }[]> = Object.create(null) as Record<string, { sha: string; subject: string }[]>;
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const sha = entries[i]!.trim(); const subject = entries[i + 1]!;
    if (!sha) continue;
    const type = /^([a-z][a-z0-9-]*)(?:\([^\r\n()]+\))?!?:\s/i.exec(subject)?.[1]?.toLowerCase() ?? 'other';
    (groups[type] ??= []).push({ sha, subject });
  }
  return { version, tag, head, groups };
}
export async function runReleaseArticlesCli(args: string[], deps: ReleaseArticlesDeps, print: (text: string) => void, signal?: AbortSignal): Promise<number> {
  const json = args.includes('--json'); const argv = args.filter((arg) => arg !== '--json');
  try {
    let result;
    if (argv.length === 1 && argv[0] === 'status') result = readReleaseArticles();
    else if (argv.length === 1 && argv[0] === 'metadata') result = await verifyLatestWorkbenchRelease(deps.reader, deps.now(), signal);
    else if (argv.length === 1 && argv[0] === 'gap') result = await releaseGapReport(process.cwd(), signal);
    else if (argv.length <= 2 && argv[0] === 'enable') {
      const repository = argv[1];
      if (repository !== undefined && repository !== 'ashlrai/ashlr-hub' && repository !== 'ashlrai/phantom') throw new Error('Invalid release repository');
      result = configureReleaseArticles(true, repository);
    } else if (argv.length === 1 && argv[0] === 'disable') result = configureReleaseArticles(false);
    else if (argv.length === 2 && argv[0] === 'import') {
      const read = readPrivateFileCapped(argv[1]!, 4096);
      if (!read || read.truncated) throw new Error('Proposed release file unavailable');
      result = importProposedRelease(JSON.parse(read.text) as unknown);
    } else if (argv.length <= 2 && argv[0] === 'sync') result = await syncReleaseArticles(deps, signal, argv[1]);
    else { print(RELEASE_ARTICLES_USAGE); return 2; }
    print(json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return 0;
  } catch {
    print(json ? JSON.stringify({ ok: false, reason: 'Release article operation withheld; inspect configuration and public verification.' }) :
      'Release article operation withheld. Configuration or public verification is unavailable; no publication was performed.');
    return 1;
  }
}
export async function cmdReleaseArticles(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(RELEASE_ARTICLES_USAGE + '\n'); return 0; }
  // Only --json is an option. Any other dash token (e.g. `sync --dryrun`) used to
  // reach sync as its version operand; refuse it before any work. Kept local:
  // this file is a Tier-1 root, so it imports no shared CLI parser.
  const operands = args.filter((arg) => arg !== '--json');
  const unknown = operands.find((arg, index) => arg.length > 1 && arg.startsWith('-') && !(index === 1 && operands[0] === 'import'));
  if (unknown !== undefined) {
    if (args.includes('--json')) process.stdout.write(JSON.stringify({ ok: false, reason: `unknown option: ${unknown}` }) + '\n');
    else process.stderr.write(`unknown option: ${unknown}\n${RELEASE_ARTICLES_USAGE}\n`);
    return 2;
  }
  const controller = new AbortController(); const stop = (): void => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { return await runReleaseArticlesCli(args, defaultReleaseArticlesDeps(), (line) => process.stdout.write(line + '\n'), controller.signal); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
