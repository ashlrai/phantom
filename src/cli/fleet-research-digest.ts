/**
 * `phm fleet research-digest` — the research loop's review gate.
 *
 * Reads a research digest (harness-digest S-source records plus a
 * `## Proposals` section), emits scored, bounded `- READY` line proposals
 * with provenance and dedup vs queued/shipped work, and — only with
 * `--apply --queue <file>` — appends the approved subset to a queue file.
 *
 * Dry-run by default: no writes, no network, no model calls. Exit codes:
 * 0 ok, 1 unreadable input or apply failure, 2 bad usage.
 * See docs/RESEARCH-LOOP.md.
 */
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { planResearchDigest, RESEARCH_DIGEST_DEFAULTS } from '../core/research/proposals.js';
import { restockReposRoot } from '../core/portfolio/restock-lint.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';
import { sanitizeCommandLine } from '../core/verse/shell-integration.js';

const MAX_BYTES = 1024 * 1024;
const LOCK_TIMEOUT_MS = 5_000;
const USAGE = `Usage: phm fleet research-digest --file <digest.md> [--queue <queue.md>] [--shipped <ids.txt>]
       [--repos-root <dir>] [--pools <csv>] [--limit N] [--min-score X]
       [--approve <id,...>] [--apply] [--json]

Dry-run emits the plan; --apply requires --queue and appends only proposals
that pass parse, dedup and the admission lint. --approve selects ids.`;

const display = (value: string): string => sanitizeCommandLine(value).replace(/\n+/g, ' ');

interface Flags {
  file?: string; queue?: string; shipped?: string; reposRoot?: string;
  pools?: string; approve?: string;
  limit?: number; minScore?: number; apply: boolean; json: boolean;
}

function parseArgs(args: string[]): Flags | 'help' | 'usage' {
  const flags: Flags = { apply: false, json: false };
  const valueFlags = new Set(['--file', '--queue', '--shipped', '--repos-root', '--pools', '--limit', '--min-score', '--approve']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--json' && !flags.json) { flags.json = true; continue; }
    if (arg === '--apply' && !flags.apply) { flags.apply = true; continue; }
    if (!valueFlags.has(arg)) return 'usage';
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) return 'usage';
    switch (arg) {
      case '--file': if (flags.file !== undefined) return 'usage'; flags.file = value; break;
      case '--queue': if (flags.queue !== undefined) return 'usage'; flags.queue = value; break;
      case '--shipped': if (flags.shipped !== undefined) return 'usage'; flags.shipped = value; break;
      case '--repos-root': if (flags.reposRoot !== undefined) return 'usage'; flags.reposRoot = value; break;
      case '--pools': if (flags.pools !== undefined) return 'usage'; flags.pools = value; break;
      case '--approve': if (flags.approve !== undefined) return 'usage'; flags.approve = value; break;
      case '--limit':
        if (flags.limit !== undefined || !/^[0-9]{1,2}$/.test(value)) return 'usage';
        flags.limit = Number(value); break;
      case '--min-score':
        if (flags.minScore !== undefined || !/^\d{1,2}(\.\d)?$/.test(value)) return 'usage';
        flags.minScore = Number(value); break;
    }
  }
  return flags;
}

/** Bounded read of a queue/evidence file; throws on any unsafe shape. */
async function readBounded(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Invalid file');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error('File too large');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}

/**
 * Append `lines` under an exclusive `<queue>.research-digest.lock`; the lock
 * is never stolen and the rewrite is atomic (temp file, fsync, rename).
 */
async function appendQueueLines(queuePath: string, lines: readonly string[]): Promise<void> {
  const lockPath = `${queuePath}.research-digest.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let lock;
  for (;;) {
    try { lock = await open(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('queue lock busy');
      await new Promise(r => setTimeout(r, 10));
    }
  }
  const token = randomUUID();
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token }));
    const current = await readBounded(queuePath).catch(() => '');
    const temp = `${queuePath}.${randomUUID()}.tmp`;
    const out = await open(temp, 'wx', 0o600);
    try {
      const text = (current && !current.endsWith('\n') ? `${current}\n` : current) + lines.map(l => `${l}\n`).join('');
      await out.writeFile(text, 'utf8');
      await out.sync();
      await out.close();
      await rename(temp, queuePath);
    } finally {
      await out.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
    }
  } finally {
    await lock.close().catch(() => undefined);
    const held = await open(lockPath, 'r').then(f => f.readFile('utf8').finally(() => f.close())).catch(() => undefined);
    if (held?.includes(token)) await unlink(lockPath).catch(() => undefined);
  }
}

export async function cmdFleetResearchDigest(args: string[], opts: { now?: () => Date } = {}): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === 'help') { console.log(USAGE); return 0; }
  if (parsed === 'usage' || !parsed.file) { console.error(USAGE); return 2; }
  if (parsed.apply && !parsed.queue) { console.error('research-digest: --apply requires --queue'); console.error(USAGE); return 2; }
  if (parsed.limit !== undefined && (parsed.limit > RESEARCH_DIGEST_DEFAULTS.maxLimit)) {
    console.error(`research-digest: --limit max ${RESEARCH_DIGEST_DEFAULTS.maxLimit}`); return 2;
  }
  const json = parsed.json;
  const fail = (message: string, code = 1): number => {
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`research-digest: ${message}`);
    return code;
  };

  const digestPath = resolve(parsed.file);
  const read = readStableRegularFile(digestPath, { anchorPath: dirname(digestPath), maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  if (!read.ok) return fail(`cannot read digest ${display(parsed.file)}`);
  const queuePath = parsed.queue ? resolve(parsed.queue) : undefined;
  let queueText: string | undefined;
  if (queuePath) {
    try { queueText = await readBounded(queuePath); }
    catch { return fail(`cannot read queue ${display(parsed.queue!)}`); }
  }
  let shipped: string[] | undefined;
  if (parsed.shipped) {
    try { shipped = (await readBounded(resolve(parsed.shipped))).split('\n').map(l => l.trim()).filter(Boolean); }
    catch { return fail(`cannot read shipped evidence ${display(parsed.shipped)}`); }
  }
  const approved = parsed.approve?.split(',').map(id => id.trim()).filter(Boolean);
  const now = (opts.now ?? (() => new Date()))();

  const plan = planResearchDigest(read.text, {
    queue: queueText,
    shipped,
    digestLabel: basename(digestPath),
    limit: parsed.limit,
    minScore: parsed.minScore,
    now,
    lint: { reposRoot: parsed.reposRoot ?? restockReposRoot(), pools: parsed.pools ? new Set(parsed.pools.split(',').map(p => p.trim()).filter(Boolean)) : undefined },
  });

  let queued: string[] = [];
  if (parsed.apply) {
    const selected = plan.proposals.filter(p => approved === undefined || approved.includes(p.id));
    try {
      if (selected.length) {
        await appendQueueLines(queuePath!, selected.map(p => p.ready));
        queued = selected.map(p => p.id);
      }
    } catch { return fail('queue write failed'); }
  }

  const report = {
    ok: true, file: digestPath, generated: now.toISOString(), applied: parsed.apply,
    sources: plan.sources, candidates: plan.candidates,
    proposals: plan.proposals.map(({ ready, ...p }) => ({ ...p, ready })),
    drops: plan.drops, queued,
  };
  if (json) { console.log(JSON.stringify(report, null, 2)); return 0; }
  console.log(`research-digest: ${plan.proposals.length} proposal(s), ${plan.drops.length} drop(s)`);
  for (const p of plan.proposals) console.log(`${p.id} score=${p.score} ${p.priority} ${p.repo}/${p.pool}/${p.tier} srcs=${p.sources.join(',')} -> ${p.ready}`);
  for (const d of plan.drops) console.log(`drop ${d.stage} line=${d.line} id=${d.id ?? '-'} reasons=${d.reasons.join(',')}`);
  if (parsed.apply) console.log(`queued: ${queued.length ? queued.join(', ') : 'none'}`);
  return 0;
}
