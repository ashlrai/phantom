/**
 * Owner spend budget file. Agents cannot write it. Every successful change
 * appends one audit line. A missing or unreadable file stays at the 0 default.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import {
  DEFAULT_SPEND_BUDGET,
  SPEND_BUDGET_SCHEMA,
  parseSpendBudget,
  spendBudgetChangeRefused,
  withSpendEntry,
  type SpendBudgetEntry,
  type SpendBudgetPolicy,
} from './budget-policy.js';

const MAX_BYTES = 64 * 1024;

export function spendBudgetPath(root = ashlrHome()): string {
  return join(root, 'spend-budget.json');
}

export function spendBudgetAuditPath(root = ashlrHome()): string {
  return join(root, 'spend-budget-audit.jsonl');
}

export class SpendBudgetOwnerError extends Error {
  constructor() {
    super('Spend budget changes require the owner. Agents cannot set a budget.');
    this.name = 'SpendBudgetOwnerError';
  }
}

async function readPolicyFile(path: string): Promise<SpendBudgetPolicy | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const current = await handle.stat();
    if (!current.isFile() || current.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(current.size);
    await handle.read(bytes, 0, bytes.length, 0);
    return parseSpendBudget(JSON.parse(bytes.toString('utf8')));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export async function readSpendBudget(root = ashlrHome()): Promise<{ policy: SpendBudgetPolicy; source: 'owner' | 'default' }> {
  if (!isAbsolute(root)) return { policy: structuredClone(DEFAULT_SPEND_BUDGET), source: 'default' };
  const policy = await readPolicyFile(spendBudgetPath(root));
  return policy ? { policy, source: 'owner' } : { policy: structuredClone(DEFAULT_SPEND_BUDGET), source: 'default' };
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = join(join(path, '..'), `.spend-budget-${randomUUID()}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function appendAudit(path: string, line: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('invalid audit sink');
    await handle.writeFile(line);
  } finally {
    await handle.close();
  }
}

export async function setSpendBudget(entry: SpendBudgetEntry, options: {
  env?: NodeJS.ProcessEnv;
  root?: string;
  now?: () => Date;
}): Promise<SpendBudgetPolicy> {
  const env = options.env ?? process.env;
  // A caller-supplied env cannot hide markers on this process.
  if (spendBudgetChangeRefused(env) || spendBudgetChangeRefused(process.env)) throw new SpendBudgetOwnerError();
  const parsed = parseSpendBudget({ schema: SPEND_BUDGET_SCHEMA, entries: [entry] });
  if (!parsed) throw new Error('Spend budget entry is invalid');
  const root = options.root ?? ashlrHome();
  if (!isAbsolute(root)) throw new Error('Spend budget root must be absolute');
  const current = await readSpendBudget(root);
  const from = current.policy.entries.find((row) => row.provider === entry.provider && row.period === entry.period)?.usd ?? 0;
  const next = withSpendEntry(current.policy, parsed.entries[0]!);
  const path = spendBudgetPath(root);
  const previous = await readPolicyFile(path);
  await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  const at = (options.now ?? (() => new Date()))().toISOString();
  try {
    await appendAudit(spendBudgetAuditPath(root), `${JSON.stringify({ at, provider: entry.provider, period: entry.period, fromUsd: from, toUsd: entry.usd, by: 'owner' })}\n`);
  } catch (error) {
    if (previous) await writeAtomic(path, `${JSON.stringify(previous, null, 2)}\n`).catch(() => undefined);
    else await unlink(path).catch(() => undefined);
    throw error;
  }
  return next;
}
