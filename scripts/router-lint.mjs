#!/usr/bin/env node
// RQ-MR-8-SIZE-CAP — router queue admission lint (dispatchd step).
//
// Reads candidate router queue lines and reports which ones the size cap
// rejects — a line touching more than one top-level area or carrying an
// EST-LINES estimate over 300 — along with the proposed split into
// dependency-free children (one per top-level area, each sliced under the
// line cap, no depends= edges). Lines whose scope or estimate cannot be
// measured are reported `review`, never silently admitted.
//
//   phantom exec -- node scripts/router-lint.mjs [--input PATH]
//     [--max-lines N] [--max-areas N] [--max-children N]
//
// Input defaults to stdin and is capped at 8 MiB / 20,000 lines. Requires
// `npm run build` (imports dist). The report on stdout is a proposal only:
// this command never writes, reorders or mutates the queue — the bridge
// applies accepted splits under its own lock after revalidating.
//
// Exit 0 when no admission line was rejected or malformed; 1 when findings
// exist; 2 on usage or I/O errors.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'node scripts/router-lint.mjs [--input PATH] [--max-lines N] [--max-areas N] [--max-children N]';
const INPUT_CAP_BYTES = 8 * 1024 * 1024;

/** One bounded read: the size cap cannot be raced by growth after stat. */
async function readCapped(file) {
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > INPUT_CAP_BYTES) throw new Error('invalid input');
  const buffer = Buffer.alloc(INPUT_CAP_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > INPUT_CAP_BYTES) throw new Error('input too large');
  return buffer.subarray(0, length).toString('utf8');
}

async function readInput(path) {
  if (path === null) {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > INPUT_CAP_BYTES) throw new Error('input too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await readCapped(file); } finally { await file.close(); }
}

async function main() {
  const flags = { '--input': null, '--max-lines': null, '--max-areas': null, '--max-children': null };
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  if (args.length % 2 !== 0) { console.error(`usage: ${USAGE}`); return 2; }
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!(flag in flags) || flags[flag] !== null || args[i + 1].startsWith('--')) {
      console.error(`usage: ${USAGE}`);
      return 2;
    }
    flags[flag] = args[i + 1];
  }
  const number = (name) => {
    const value = flags[name];
    if (value === null) return undefined;
    return /^\d{1,7}$/.test(value) && Number(value) >= 1 ? Number(value) : null;
  };
  const options = {
    maxEstLines: number('--max-lines'),
    maxAreas: number('--max-areas'),
    maxChildrenPerLine: number('--max-children'),
  };
  if (Object.values(options).some((value) => value === null)) {
    console.error(`usage: ${USAGE}`);
    return 2;
  }
  let text;
  try {
    text = await readInput(flags['--input'] === null ? null : resolve(flags['--input']));
  } catch {
    console.error('RLINT_INPUT');
    return 2;
  }
  const { lintRouterQueueText } = await import('../dist/core/drive/router-lint.js');
  const report = lintRouterQueueText(text, options);
  console.log(JSON.stringify(report, null, 2));
  return report.counts.reject > 0 || report.counts.invalid > 0 ? 1 : 0;
}

// Only run when executed directly (the dispatchd step), never on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => process.exit(code)).catch(() => {
    console.error('RLINT_ERROR');
    process.exit(1);
  });
}
