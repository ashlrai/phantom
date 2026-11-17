/**
 * `phm pages` - publish and list report pages for the local dashboard.
 *
 *   phm pages publish <file.md|file.json> [--slug <s>] [--title <t>] [--json]
 *   phm pages list [--json]
 *
 * Publishing renders a report into a stored page the loopback dashboard
 * serves at /pages/<slug> (the console route under /next/) backed by
 * GET /api/pages/<slug>. Loopback only, nothing public; the store lives at
 * ~/.ashlr/pages. See docs/PAGES.md.
 */

import { makeColors, isTty } from './ui.js';
import { listPages, publishPage, type PublishFailureReason } from '../core/cos/pages.js';

const USAGE = 'phm pages publish <file.md|file.json> [--slug <s>] [--title <t>] [--json] | phm pages list [--json]';

function help(): void {
  console.log([
    'Usage: phm pages publish <file.md|file.json> [--slug <s>] [--title <t>] [--json]',
    '       phm pages list [--json]',
    '',
    'publish renders a Markdown or JSON report into a dashboard page at',
    '/pages/<slug> (loopback only; stored under ~/.ashlr/pages). Republishing',
    'the same slug replaces the page. list prints every published page,',
    'newest first.',
  ].join('\n'));
}

function invalidUsage(json: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      error: { code: 'invalid-usage' },
      usage: USAGE,
    })}\n`);
  } else {
    help();
  }
  return 2;
}

function failureExitCode(reason: PublishFailureReason): number {
  // Bad operator input is a usage error; store/IO failures are plain errors.
  return reason === 'write-failed' ? 1 : 2;
}

function cmdPagesPublish(args: string[]): number {
  const col = makeColors(isTty());
  let json = false;
  let slug: string | undefined;
  let title: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--slug' && slug === undefined && args[i + 1] !== undefined) slug = args[++i];
    else if (arg === '--title' && title === undefined && args[i + 1] !== undefined) title = args[++i];
    else if (arg === '--help' || arg === '-h') { help(); return 0; }
    else if (!arg.startsWith('-')) positional.push(arg);
    else return invalidUsage(args.includes('--json'));
  }
  if (positional.length !== 1) return invalidUsage(args.includes('--json'));

  const result = publishPage({
    filePath: positional[0]!,
    ...(slug !== undefined ? { slug } : {}),
    ...(title !== undefined ? { title } : {}),
  });
  if (!result.ok) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, published: false, error: { code: result.reason, message: result.message } })}\n`);
    } else {
      console.error(col.red('error: ') + result.message);
    }
    return failureExitCode(result.reason);
  }

  const { page, file } = result;
  const route = `/pages/${page.slug}`;
  if (json) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      published: true,
      slug: page.slug,
      title: page.title,
      route,
      apiPath: `/api/pages/${page.slug}`,
      consolePath: `/next/#${route}`,
      file,
      publishedAt: page.publishedAt,
      bytes: page.bytes,
    }, null, 2)}\n`);
    return 0;
  }
  console.log('');
  console.log(`  ${col.green('✓')} Published ${col.bold(page.title)} at ${col.cyan(route)}`);
  console.log(col.dim(`    Stored: ${file}`));
  console.log(col.dim('    Open it from `phm dashboard` (or `phm serve --open`):'));
  console.log(`    ${col.cyan(`/next/#${route}`)}`);
  console.log('');
  return 0;
}

function cmdPagesList(args: string[]): number {
  const col = makeColors(isTty());
  let json = false;
  for (const arg of args) {
    if (arg === '--json' && !json) json = true;
    else if (arg === '--help' || arg === '-h') { help(); return 0; }
    else return invalidUsage(args.includes('--json'));
  }
  const pages = listPages();
  if (json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, count: pages.length, pages }, null, 2)}\n`);
    return 0;
  }
  if (pages.length === 0) {
    console.log(col.dim('  No pages published yet. `phm pages publish <file.md>` creates one.'));
    return 0;
  }
  console.log('');
  for (const page of pages) {
    console.log(`  ${col.cyan(`/pages/${page.slug}`)}  ${col.bold(page.title)}`);
    console.log(`    ${col.dim(page.publishedAt)}${page.description ? `  ${page.description}` : ''}`);
  }
  console.log('');
  console.log(col.dim(`  ${pages.length} page${pages.length === 1 ? '' : 's'}`));
  return 0;
}

export async function cmdPages(args: string[]): Promise<number> {
  const verb = args[0];
  if (verb === 'publish') return cmdPagesPublish(args.slice(1));
  if (verb === 'list') return cmdPagesList(args.slice(1));
  if (verb === 'help' || verb === '--help' || verb === '-h' || verb === undefined) {
    help();
    return verb === undefined ? 2 : 0;
  }
  return invalidUsage(args.includes('--json'));
}
