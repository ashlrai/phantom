/**
 * Owner spend budget file. The path is the account home from realHome(), so
 * HOME and ASHLR_HOME cannot point the reader at a decoy. A missing, corrupt,
 * or unattested file stays at the 0 default.
 *
 * A budget above 0 is honored only with an attestation:
 * - pin-chain: the policy hash is the detail of a verified authority-ledger
 *   note, and the attestation names that note's chain hash;
 * - mason-approval: a Mason operator approval records the same digest.
 * The ledger and the approval file follow the process home. They count only
 * when that home is the account home. Any miss, mismatch, or read error is 0.
 * `setSpendBudget` also refuses agent markers and a non-interactive terminal.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { appendLedger, ledgerEntryHash, readLedger } from '../authority/ledger.js';
import { realHome } from '../real-home.js';
import { listOperatorApprovals } from '../vision/leader-operator.js';
import {
  DEFAULT_SPEND_BUDGET,
  SPEND_BUDGET_SCHEMA,
  effectiveSpendBudget,
  parseSpendBudget,
  parseSpendBudgetDocument,
  spendBudgetChangeRefused,
  spendBudgetPolicyHash,
  withSpendEntry,
  type SpendBudgetAttestation,
  type SpendBudgetEntry,
  type SpendBudgetPolicy,
} from './budget-policy.js';

const MAX_BYTES = 64 * 1024;
const SPEND_BUDGET_NOTE_TOPIC = 'spend-budget';
const SPEND_BUDGET_APPROVAL_KIND = 'spend-budget';

export function spendBudgetDirectory(root?: string): string | null {
  if (root !== undefined) return isAbsolute(root) ? root : null;
  const home = realHome();
  return home ? join(home, '.ashlr') : null;
}

export function spendBudgetPath(root?: string): string {
  return join(spendBudgetDirectory(root) ?? '', 'spend-budget.json');
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

/** The pin chain and the approval file follow homedir(). Trust them only on the account home. */
export function spendBudgetAccountHome(): boolean {
  const account = realHome();
  if (!account) return false;
  try {
    return resolve(account) === resolve(homedir());
  } catch {
    return false;
  }
}

function interactiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function readPolicyFile(path: string): Promise<{ policy: SpendBudgetPolicy; attestation: SpendBudgetAttestation | null } | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const current = await handle.stat();
    if (!current.isFile() || current.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(current.size);
    await handle.read(bytes, 0, bytes.length, 0);
    return parseSpendBudgetDocument(JSON.parse(bytes.toString('utf8')));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function pinChainHonors(policy: SpendBudgetPolicy, attestation: Extract<SpendBudgetAttestation, { kind: 'pin-chain' }>): Promise<boolean> {
  const hash = spendBudgetPolicyHash(policy);
  if (attestation.hash !== hash) return false;
  const ledger = await readLedger();
  if (ledger.chain !== 'ok') return false;
  return ledger.entries.some((entry) => entry.kind === 'note'
    && entry.actor === 'mason'
    && entry.grantId === null
    && entry.repo === null
    && entry.hash === attestation.chain
    && entry.data.topic === SPEND_BUDGET_NOTE_TOPIC
    && entry.data.detail === hash);
}

function masonApprovalHonors(policy: SpendBudgetPolicy, attestation: Extract<SpendBudgetAttestation, { kind: 'mason-approval' }>): boolean {
  const hash = spendBudgetPolicyHash(policy);
  if (attestation.digest !== hash || attestation.id !== hash) return false;
  return listOperatorApprovals(200).some((approval) => approval.outcome === 'applied'
    && approval.kind === SPEND_BUDGET_APPROVAL_KIND
    && approval.actionId === hash);
}

async function attestationHonored(policy: SpendBudgetPolicy, attestation: SpendBudgetAttestation | null): Promise<boolean> {
  if (policy.entries.every((entry) => entry.usd === 0)) return true;
  if (!attestation || !spendBudgetAccountHome()) return false;
  switch (attestation.kind) {
    case 'pin-chain':
      return pinChainHonors(policy, attestation);
    case 'mason-approval':
      return masonApprovalHonors(policy, attestation);
    default: {
      const unexpected: never = attestation;
      return unexpected;
    }
  }
}

export async function readSpendBudget(root?: string): Promise<{ policy: SpendBudgetPolicy; source: 'owner' | 'default' }> {
  const dir = spendBudgetDirectory(root);
  if (!dir) return { policy: structuredClone(DEFAULT_SPEND_BUDGET), source: 'default' };
  const document = await readPolicyFile(spendBudgetPath(dir));
  if (!document) return { policy: structuredClone(DEFAULT_SPEND_BUDGET), source: 'default' };
  let attested = false;
  try {
    attested = await attestationHonored(document.policy, document.attestation);
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

function pinSpendBudget(policy: SpendBudgetPolicy): SpendBudgetAttestation {
  const hash = spendBudgetPolicyHash(policy);
  const appended = appendLedger({
    kind: 'note',
    actor: 'mason',
    grantId: null,
    repo: null,
    data: { topic: SPEND_BUDGET_NOTE_TOPIC, detail: hash },
  });
  if (!appended.ok || appended.entry.hash !== ledgerEntryHash(appended.entry)) {
    throw new Error('Spend budget attestation was not recorded');
  }
  return { kind: 'pin-chain', hash, chain: appended.entry.hash };
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
  const current = await readSpendBudget(root);
  const from = current.policy.entries.find((row) => row.provider === entry.provider && row.period === entry.period)?.usd ?? 0;
  const next = withSpendEntry(current.policy, parsed.entries[0]!);
  if (next.entries.some((row) => row.usd > 0) && !spendBudgetAccountHome()) {
    throw new SpendBudgetOwnerError('Spend budget changes require the account home.');
  }
  const path = spendBudgetPath(root);
  const previous = await readPolicyFile(path);
  const body = next.entries.some((row) => row.usd > 0)
    ? { ...next, attestation: pinSpendBudget(next) }
    : next;
  await writeAtomic(path, `${JSON.stringify(body, null, 2)}\n`);
  const at = (options.now ?? (() => new Date()))().toISOString();
  try {
    await appendAudit(spendBudgetAuditPath(root), `${JSON.stringify({ at, provider: entry.provider, period: entry.period, fromUsd: from, toUsd: entry.usd, by: 'owner' })}\n`);
  } catch (error) {
    if (previous) await writeAtomic(path, `${JSON.stringify(previous.attestation ? { ...previous.policy, attestation: previous.attestation } : previous.policy, null, 2)}\n`).catch(() => undefined);
    else await unlink(path).catch(() => undefined);
    throw error;
  }
  return next;
}
