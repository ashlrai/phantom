/**
 * Owner spend budget file. The path is the account home from realHome(), so
 * HOME and ASHLR_HOME cannot point the reader at a decoy.
 *
 * A budget above 0 is honored only from a root this account cannot mint.
 * This repo has no mode-444 Security pin-chain verifier and no Masbot or
 * owner signature verifier for a spend budget, so the effective amount stays
 * 0. A ledger note and an operator approval are not roots.
 *
 * Lowering or zeroing an entry bumps a monotonic epoch stored beside the
 * budget file. An older file, restored after that bump, does not match.
 * `setSpendBudget` still refuses agent markers and a non-interactive terminal.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { realHome } from '../real-home.js';
import {
  DEFAULT_SPEND_BUDGET,
  SPEND_BUDGET_SCHEMA,
  effectiveSpendBudget,
  parseSpendBudget,
  parseSpendBudgetDocument,
  spendBudgetChangeRefused,
  spendBudgetPolicyHash,
  spendBudgetRootHonors,
  withSpendEntry,
  type SpendBudgetAttestation,
  type SpendBudgetDocument,
  type SpendBudgetEntry,
  type SpendBudgetPolicy,
} from './budget-policy.js';

const MAX_BYTES = 64 * 1024;
const EPOCH_SCHEMA = 'spend.budget.epoch.v1';

export function spendBudgetDirectory(root?: string): string | null {
  if (root !== undefined) return isAbsolute(root) ? root : null;
  const home = realHome();
  return home ? join(home, '.ashlr') : null;
}

export function spendBudgetPath(root?: string): string {
  return join(spendBudgetDirectory(root) ?? '', 'spend-budget.json');
}

export function spendBudgetEpochPath(root?: string): string {
  return join(spendBudgetDirectory(root) ?? '', 'spend-budget-epoch.json');
}

export function spendBudgetAuditPath(root?: string): string {
  return join(spendBudgetDirectory(root) ?? '', 'spend-budget-audit.jsonl');
}

export class SpendBudgetOwnerError extends Error {
  constructor(message = 'Spend budget changes require the owner. Agents cannot set a budget.') {
    super(message);
    this.name = 'SpendBudgetOwnerError';
  }
}

function interactiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function readCapped(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const current = await handle.stat();
    if (!current.isFile() || current.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(current.size);
    await handle.read(bytes, 0, bytes.length, 0);
    return bytes.toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function readPolicyFile(path: string): Promise<SpendBudgetDocument | null> {
  const text = await readCapped(path);
  if (text === null) return null;
  try {
    return parseSpendBudgetDocument(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Missing epoch is 0. A corrupt epoch matches nothing. */
export async function readSpendBudgetEpoch(root?: string): Promise<number | null> {
  const dir = spendBudgetDirectory(root);
  if (!dir) return null;
  const text = await readCapped(spendBudgetEpochPath(dir));
  if (text === null) return 0;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const body = parsed as Record<string, unknown>;
    if (body['schema'] !== EPOCH_SCHEMA) return null;
    if (Object.keys(body).some((key) => key !== 'schema' && key !== 'epoch')) return null;
    return typeof body['epoch'] === 'number' && Number.isSafeInteger(body['epoch']) && body['epoch'] >= 0
      ? body['epoch']
      : null;
  } catch {
    return null;
  }
}

function decreased(previous: SpendBudgetPolicy, next: SpendBudgetPolicy): boolean {
  return previous.entries.some((before) => {
    const after = next.entries.find((row) => row.provider === before.provider && row.period === before.period);
    return (after?.usd ?? 0) < before.usd;
  });
}

function attestationHash(attestation: SpendBudgetAttestation): string {
  switch (attestation.kind) {
    case 'pin-chain':
    case 'recorded':
      return attestation.hash;
    case 'mason-approval':
      return attestation.digest;
    default: {
      const unexpected: never = attestation;
      return unexpected;
    }
  }
}

async function attestationHonored(policy: SpendBudgetPolicy, attestation: SpendBudgetAttestation | null, epoch: number | null): Promise<boolean> {
  if (policy.entries.every((entry) => entry.usd === 0)) return true;
  if (!attestation || epoch === null || attestation.epoch !== epoch) return false;
  if (attestationHash(attestation) !== spendBudgetPolicyHash(policy, attestation.epoch)) return false;
  return spendBudgetRootHonors(attestation);
}

export async function readSpendBudget(root?: string): Promise<{ policy: SpendBudgetPolicy; source: 'owner' | 'default' }> {
  const dir = spendBudgetDirectory(root);
  if (!dir) return { policy: structuredClone(DEFAULT_SPEND_BUDGET), source: 'default' };
  const document = await readPolicyFile(spendBudgetPath(dir));
  if (!document) return { policy: structuredClone(DEFAULT_SPEND_BUDGET), source: 'default' };
  let attested = false;
  try {
    attested = await attestationHonored(document.policy, document.attestation, await readSpendBudgetEpoch(dir));
  } catch {
    attested = false;
  }
  return { policy: effectiveSpendBudget(document.policy, attested), source: 'owner' };
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

function recordedAttestation(policy: SpendBudgetPolicy, epoch: number): SpendBudgetAttestation {
  return { kind: 'recorded', hash: spendBudgetPolicyHash(policy, epoch), epoch };
}

export async function setSpendBudget(entry: SpendBudgetEntry, options: {
  env?: NodeJS.ProcessEnv;
  root?: string;
  now?: () => Date;
}): Promise<SpendBudgetPolicy> {
  const env = options.env ?? process.env;
  // A caller-supplied env cannot hide markers on this process.
  if (spendBudgetChangeRefused(env) || spendBudgetChangeRefused(process.env)) throw new SpendBudgetOwnerError();
  if (!interactiveTerminal()) {
    throw new SpendBudgetOwnerError('Spend budget changes require an interactive terminal. Agents cannot set a budget.');
  }
  const parsed = parseSpendBudget({ schema: SPEND_BUDGET_SCHEMA, entries: [entry] });
  if (!parsed) throw new Error('Spend budget entry is invalid');
  const root = spendBudgetDirectory(options.root);
  if (!root) throw new Error('Spend budget root must be absolute');
  const path = spendBudgetPath(root);
  const previous = await readPolicyFile(path);
  const declared = previous?.policy ?? structuredClone(DEFAULT_SPEND_BUDGET);
  const from = declared.entries.find((row) => row.provider === entry.provider && row.period === entry.period)?.usd ?? 0;
  const next = withSpendEntry(declared, parsed.entries[0]!);
  const currentEpoch = await readSpendBudgetEpoch(root);
  if (currentEpoch === null) throw new Error('Spend budget epoch is unreadable');
  const epoch = decreased(declared, next) ? currentEpoch + 1 : currentEpoch;
  if (epoch !== currentEpoch) {
    await writeAtomic(spendBudgetEpochPath(root), `${JSON.stringify({ schema: EPOCH_SCHEMA, epoch })}\n`);
  }
  const body = next.entries.some((row) => row.usd > 0)
    ? { ...next, attestation: recordedAttestation(next, epoch) }
    : next;
  try {
    await writeAtomic(path, `${JSON.stringify(body, null, 2)}\n`);
  } catch (error) {
    if (epoch !== currentEpoch) await writeAtomic(spendBudgetEpochPath(root), `${JSON.stringify({ schema: EPOCH_SCHEMA, epoch: currentEpoch })}\n`).catch(() => undefined);
    throw error;
  }
  const at = (options.now ?? (() => new Date()))().toISOString();
  try {
    await appendAudit(spendBudgetAuditPath(root), `${JSON.stringify({ at, provider: entry.provider, period: entry.period, fromUsd: from, toUsd: entry.usd, by: 'owner' })}\n`);
  } catch (error) {
    if (previous) await writeAtomic(path, `${JSON.stringify(previous.attestation ? { ...previous.policy, attestation: previous.attestation } : previous.policy, null, 2)}\n`).catch(() => undefined);
    else await unlink(path).catch(() => undefined);
    if (epoch !== currentEpoch) await writeAtomic(spendBudgetEpochPath(root), `${JSON.stringify({ schema: EPOCH_SCHEMA, epoch: currentEpoch })}\n`).catch(() => undefined);
    throw error;
  }
  return (await readSpendBudget(root)).policy;
}
