/**
 * `phm connect`: one-approval-per-account sign-in wizard for agents and nodes.
 *
 *   phm connect                          the wizard: discover, card, approve each account
 *   phm connect discover [--json]        probe vendor status commands (read-only)
 *   phm connect status [--json]          what is connected where; pending requests; actions
 *   phm connect requests [--json]        request queue (pending first)
 *   phm connect request <svc> --node <n> agent-side: file a PENDING connection request
 *   phm connect approve <request|svc>    operator-side: card + explicit approval -> transfer
 *   phm connect deny <request>           refuse a pending request
 *   phm connect revoke <grant|svc>       revoke a live grant
 *
 * Invariants:
 *   - Discovery runs vendor status commands only; token and session file
 *     contents are never read for detection.
 *   - Every grant needs an explicit interactive approval. There is no
 *     auto-approval path and no flag that skips approval: `request` can only
 *     ever create a `pending` record.
 *   - Transfer order is strict: vendor device-code/OAuth login on the target
 *     node, then a scoped token vaulted in Phantom Secrets, and raw
 *     session-file copy only as a per-file-approved, sealed last resort.
 *   - The CMP Codex session (~/.codex) is excluded from copy, move and
 *     rotation.
 *   - Every state change writes a value-free audit entry.
 *
 * Exit codes: 0 ok, 1 error/refused, 2 usage.
 */

import { createInterface } from 'node:readline';
import { getConnectService, isConnectServiceId } from '../core/connect/services.js';
import { discoverConnectAccounts, discoverOne } from '../core/connect/discovery.js';
import {
  approveConnectRequest,
  createConnectRequest,
  denyConnectRequest,
  findConnectGrant,
  findConnectRequest,
  pendingConnectRequests,
  resolveNodeId,
  revokeConnectGrant,
  activeConnectGrant,
} from '../core/connect/requests.js';
import { loadConnectStore, saveConnectStore } from '../core/connect/store.js';
import {
  executeConnectTransfer,
  listSessionFiles,
  removeSealedBundle,
} from '../core/connect/transfer.js';
import {
  auditConnectDeny,
  auditConnectGrant,
  auditConnectRefusal,
  auditConnectRequest,
  auditConnectRevoke,
} from '../core/connect/audit.js';
import { isTty, makeColors } from './ui.js';
import type {
  ConnectDeps,
  ConnectDiscoveryRow,
  ConnectGrant,
  ConnectRequest,
  ConnectServiceId,
  ConnectStore,
  ConnectTransferMethod,
} from '../core/connect/types.js';
import { CONNECT_METHOD_ORDER, CONNECT_SERVICE_IDS } from '../core/connect/types.js';

const USAGE = `phm connect: one-approval-per-account sign-in wizard for agents and nodes

Usage:
  phm connect                          wizard: discover signed-in services, approve each account
  phm connect discover [--json]        probe vendor sign-ins (status commands only)
  phm connect status [--json]          what is connected where, pending requests, actions
  phm connect requests [--json]        request queue (pending first)
  phm connect request <service> --node <id> [--scope <s>] [--method <m>]
                                       file a request that stays pending until Mason approves
  phm connect approve <request-id|service> [--node <id>]
                                       show the approve card; on an explicit yes, transfer access
  phm connect deny <request-id> [--reason <text>]
                                       refuse a pending request
  phm connect revoke <grant-id|service> [--reason <text>]
                                       revoke a live grant (asks first)

Services: ${CONNECT_SERVICE_IDS.join(', ')}
Transfer order: ${CONNECT_METHOD_ORDER.join(' -> ')}. Session copy is a sealed,
per-file-approved last resort; ~/.codex is excluded from copy, move and rotation.
Every grant and revocation is recorded in the audit log (value-free).`;

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface ConnectCliDeps {
  core: ConnectDeps;
  /** Interactive y/N confirmation. The ONLY approval path: never a flag. */
  confirm(question: string): Promise<boolean>;
  out(line: string): void;
  err(line: string): void;
}

async function realConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((done) => rl.question(`${question} [y/N] `, done));
    return /^y(es)?$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function defaultDeps(): Promise<ConnectCliDeps> {
  const [depsMod, registry] = await Promise.all([
    import('../core/connect/deps.js'),
    import('../core/mcp-registry.js'),
  ]);
  return {
    core: depsMod.defaultConnectDeps(() =>
      registry.discoverMcpServers().servers.map((s) => {
        const spec = registry.redactEnv(s);
        return { name: spec.name, command: spec.command };
      })),
    confirm: realConfirm,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

// ---------------------------------------------------------------------------
// Arg helpers (same idioms as cli/devin.ts)
// ---------------------------------------------------------------------------

class UsageError extends Error {}

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function takeOption(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value.`);
  args.splice(i, 2);
  return value;
}

function takeOptions(args: string[], name: string): string[] {
  const values: string[] = [];
  for (;;) {
    const v = takeOption(args, name);
    if (v === null) return values;
    values.push(v);
  }
}

function rejectLeftovers(args: string[]): void {
  if (args.length > 0) {
    throw new UsageError(`Unexpected ${args[0]!.startsWith('--') ? 'option' : 'argument'} ${args[0]}.`);
  }
}

function json(deps: ConnectCliDeps, value: unknown): void {
  deps.out(JSON.stringify(value, null, 2));
}

const METHOD_SET = new Set<string>(CONNECT_METHOD_ORDER);

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function cardLines(opts: {
  service: string;
  label: string;
  account: string | null;
  node: string;
  scopes: readonly string[];
  notes?: readonly string[];
}): string[] {
  const lines = [
    '  connect approval',
    `    service:  ${opts.service} (${opts.label})`,
    `    account:  ${opts.account ?? '(sign-in not detected on this machine)'}`,
    `    node:     ${opts.node}`,
    `    scopes:   ${opts.scopes.join(', ') || '(default)'}`,
  ];
  for (const note of opts.notes ?? []) lines.push(`    note:     ${note}`);
  lines.push(`    transfer: tries ${CONNECT_METHOD_ORDER.join(' -> ')} in order`);
  return lines;
}

function rowSummary(row: ConnectDiscoveryRow): string {
  const left = `${row.service.padEnd(9)} ${row.signedIn ? (row.account ?? 'signed in').padEnd(28) : 'not signed in'}`;
  return `    ${left} ${row.scopes.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

function cmdDiscover(deps: ConnectCliDeps, args: string[]): number {
  const asJson = takeFlag(args, '--json');
  rejectLeftovers(args);
  const rows = discoverConnectAccounts(deps.core);
  if (asJson) {
    json(deps, { services: rows });
    return 0;
  }
  deps.out('Signed-in services on this machine (status commands only):');
  for (const row of rows) {
    deps.out(rowSummary(row));
    for (const note of row.notes) deps.out(`        note: ${note}`);
  }
  return 0;
}

interface StatusShape {
  discovered: ConnectDiscoveryRow[];
  pending: ConnectRequest[];
  active: ConnectGrant[];
  revoked: ConnectGrant[];
  history: ConnectRequest[];
}

function statusShape(deps: ConnectCliDeps, store: ConnectStore): StatusShape {
  const discovered = discoverConnectAccounts(deps.core);
  const pending = pendingConnectRequests(store);
  const active = store.grants.filter((g) => g.revokedAt === null);
  const revoked = store.grants.filter((g) => g.revokedAt !== null);
  const history = store.requests.filter((r) => r.status !== 'pending').slice(-20);
  return { discovered, pending, active, revoked, history };
}

function cmdStatus(deps: ConnectCliDeps, args: string[]): number {
  const asJson = takeFlag(args, '--json');
  rejectLeftovers(args);
  const shape = statusShape(deps, loadConnectStore());
  if (asJson) {
    json(deps, shape);
    return 0;
  }
  const c = makeColors(isTty());
  deps.out(c.bold('phm connect') + c.dim(': sign-in connections for agents and nodes'));
  deps.out('');
  const signed = shape.discovered.filter((r) => r.signedIn);
  deps.out('  ' + c.bold('Discovered on this machine') + c.dim(` (${signed.length} signed in)`));
  for (const row of shape.discovered) {
    if (!row.signedIn) continue;
    deps.out(rowSummary(row));
    for (const note of row.notes) deps.out(`        ${c.dim(note)}`);
  }
  if (signed.length === 0) deps.out('    (none detected)');
  deps.out('');
  deps.out('  ' + c.bold('Pending requests') + c.dim(` (${shape.pending.length})`));
  for (const r of shape.pending) {
    deps.out(`    ${r.id}  ${r.service} -> ${r.node}  scopes: ${r.scopes.join(', ') || '-'}  by ${r.requestedBy}`);
    deps.out(`        approve: phm connect approve ${r.id}   deny: phm connect deny ${r.id}`);
  }
  if (shape.pending.length === 0) deps.out('    (none)');
  deps.out('');
  deps.out('  ' + c.bold('Active grants') + c.dim(` (${shape.active.length})`));
  for (const g of shape.active) {
    const where = g.delivery === 'vaulted' && g.secretName ? `vault: ${g.secretName}` : g.delivery;
    deps.out(`    ${g.id}  ${g.service} -> ${g.node}  ${g.method} (${where})  ${g.createdAt.slice(0, 10)}`);
    deps.out(`        revoke: phm connect revoke ${g.id}`);
  }
  if (shape.active.length === 0) deps.out('    (none)');
  if (shape.revoked.length > 0) {
    deps.out('');
    deps.out('  ' + c.bold('Revoked'));
    for (const g of shape.revoked.slice(-10)) {
      deps.out(`    ${g.id}  ${g.service} -> ${g.node}  revoked ${g.revokedAt?.slice(0, 10) ?? ''}`);
    }
  }
  deps.out('');
  deps.out(c.dim('  Agents: `phm connect request <service> --node <id>` asks; nothing connects until an operator approves.'));
  return 0;
}

function cmdRequests(deps: ConnectCliDeps, args: string[]): number {
  const asJson = takeFlag(args, '--json');
  rejectLeftovers(args);
  const store = loadConnectStore();
  const sorted = [...store.requests].sort((a, b) => {
    if (a.status === b.status) return b.requestedAt.localeCompare(a.requestedAt);
    return a.status === 'pending' ? -1 : 1;
  });
  if (asJson) {
    json(deps, { requests: sorted });
    return 0;
  }
  if (sorted.length === 0) {
    deps.out('No connect requests.');
    return 0;
  }
  for (const r of sorted) {
    deps.out(`  ${r.id}  ${r.status.padEnd(8)} ${r.service} -> ${r.node}  scopes: ${r.scopes.join(', ') || '-'}  ${r.requestedAt.slice(0, 10)}`);
    if (r.note) deps.out(`      note: ${r.note}`);
  }
  return 0;
}

async function cmdRequest(deps: ConnectCliDeps, args: string[]): Promise<number> {
  const asJson = takeFlag(args, '--json');
  const nodeRaw = takeOption(args, '--node');
  const scopes = takeOptions(args, '--scope');
  const methodRaw = takeOption(args, '--method');
  const service = args.shift();
  rejectLeftovers(args);
  if (!service) throw new UsageError('Say which service: phm connect request <service> --node <id>.');
  if (!isConnectServiceId(service)) throw new UsageError(`Unknown service "${service}". Services: ${CONNECT_SERVICE_IDS.join(', ')}.`);
  const node = resolveNodeId(nodeRaw, deps.core.hostname());
  if (node === null) throw new UsageError(`Invalid node id "${nodeRaw ?? ''}".`);
  if (methodRaw !== null && !METHOD_SET.has(methodRaw)) {
    throw new UsageError(`Unknown method "${methodRaw}". Methods: ${CONNECT_METHOD_ORDER.join(', ')}.`);
  }
  const store = loadConnectStore();
  const created = createConnectRequest(store, {
    service,
    node,
    scopes: scopes.length > 0 ? scopes : getConnectService(service)!.scopes,
    method: (methodRaw as ConnectTransferMethod | null) ?? null,
    requestedBy: 'agent',
    now: deps.core.now(),
  });
  if (!created.ok) {
    deps.err(`Request refused: ${created.reason}`);
    return 1;
  }
  saveConnectStore(store);
  if (!created.deduplicated) auditConnectRequest(created.request);
  const payload = { ok: true, request: created.request, deduplicated: created.deduplicated };
  if (asJson) {
    json(deps, payload);
    return 0;
  }
  deps.out(`Request ${created.deduplicated ? 'already pending' : 'filed'}: ${created.request.id}`);
  deps.out(`  ${service} -> node ${node}  scopes: ${created.request.scopes.join(', ') || '(service defaults)'}`);
  deps.out('  It stays pending until an operator approves it. There is no flag that skips approval.');
  deps.out(`  Operator: phm connect approve ${created.request.id}`);
  return 0;
}

async function cmdDeny(deps: ConnectCliDeps, args: string[]): Promise<number> {
  const asJson = takeFlag(args, '--json');
  const reason = takeOption(args, '--reason');
  const id = args.shift();
  rejectLeftovers(args);
  if (!id) throw new UsageError('Say which request: phm connect deny <request-id>.');
  const store = loadConnectStore();
  const request = findConnectRequest(store, id);
  if (!request) {
    deps.err(`No connect request matches "${id}".`);
    return 1;
  }
  if (request.status !== 'pending') {
    deps.err(`Request ${request.id} is already ${request.status}.`);
    return 1;
  }
  denyConnectRequest(request, deps.core.now(), reason);
  saveConnectStore(store);
  auditConnectDeny(request);
  if (asJson) {
    json(deps, { ok: true, request });
    return 0;
  }
  deps.out(`Denied ${request.id} (${request.service} -> ${request.node}). Nothing was transferred.`);
  return 0;
}

/** Resolve the request an approve argument names: id prefix, or service (+ --node). */
function resolveApproveTarget(
  store: ConnectStore,
  arg: string,
  node: string | null,
): { request?: ConnectRequest; error?: string } {
  const pending = pendingConnectRequests(store);
  const byId = findConnectRequest(store, arg);
  if (byId) {
    if (byId.status !== 'pending') return { error: `Request ${byId.id} is already ${byId.status}.` };
    if (node !== null && byId.node !== node) return { error: `Request ${byId.id} targets node ${byId.node}, not ${node}.` };
    return { request: byId };
  }
  if (!isConnectServiceId(arg)) {
    return { error: `No pending request matches "${arg}".` };
  }
  const matches = pending.filter((r) => r.service === arg && (node === null || r.node === node));
  if (matches.length === 0) return { error: `No pending request for ${arg}${node ? ` on ${node}` : ''}.` };
  if (matches.length > 1) return { error: `Multiple pending requests for ${arg}; approve by request id.` };
  return { request: matches[0]! };
}

async function runApprovedTransfer(
  deps: ConnectCliDeps,
  input: {
    service: ConnectServiceId;
    node: string;
    account: string | null;
    scopes: string[];
    requestedMethod?: ConnectTransferMethod | null;
    requestId?: string | null;
  },
): Promise<{ ok: true; grant: ConnectGrant; operatorCommand?: string } | { ok: false; reason: string }> {
  const result = await executeConnectTransfer(
    {
      ...input,
      confirmSessionFile: async (rel) =>
        deps.confirm(`    copy session file ~/${rel} into a sealed bundle for ${input.node}?`),
    },
    deps.core,
  );
  if (!result.ok || !result.grant) {
    return { ok: false, reason: result.reason ?? 'transfer failed' };
  }
  return { ok: true, grant: result.grant, ...(result.operatorCommand ? { operatorCommand: result.operatorCommand } : {}) };
}

async function cmdApprove(deps: ConnectCliDeps, args: string[]): Promise<number> {
  const nodeRaw = takeOption(args, '--node');
  const arg = args.shift();
  rejectLeftovers(args);
  if (!arg) throw new UsageError('Say what to approve: phm connect approve <request-id|service>.');
  const node = nodeRaw === null ? null : resolveNodeId(nodeRaw, deps.core.hostname());
  if (nodeRaw !== null && node === null) throw new UsageError(`Invalid node id "${nodeRaw}".`);

  const store = loadConnectStore();
  const target = resolveApproveTarget(store, arg, node);
  if (!target.request) {
    deps.err(target.error ?? 'Nothing pending to approve.');
    return 1;
  }
  const request = target.request;
  const serviceId = request.service;
  const discovered = discoverOne(serviceId, deps.core);
  const label = discovered.label;
  const account = discovered.signedIn ? discovered.account : null;
  const scopes = request.scopes.length > 0 ? request.scopes : discovered.scopes;

  // The approve card: account, node, scopes, what the transfer will do.
  for (const line of cardLines({
    service: serviceId,
    label,
    account,
    node: request.node,
    scopes,
    notes: discovered.notes,
  })) deps.out(line);
  const sessionFiles = listSessionFiles(serviceId);
  if (sessionFiles.length > 0) {
    deps.out(`    session files (last-resort sealed copy asks per file): ${sessionFiles.length} present`);
  }

  // The approval itself. Interactive confirmation is the only path; a
  // non-interactive caller cannot approve anything, by design.
  if (!(await deps.confirm(`  Approve connecting ${serviceId} to ${request.node}?`))) {
    auditConnectRefusal('approve', `request=${request.id} service=${serviceId} node=${request.node} declined`);
    deps.err('Not approved. The request stays pending.');
    return 1;
  }

  const transferred = await runApprovedTransfer(deps, {
    service: serviceId,
    node: request.node,
    account,
    scopes,
    requestedMethod: request.requestedMethod,
    requestId: request.id,
  });
  if (!transferred.ok) {
    auditConnectRefusal('grant', `request=${request.id} service=${serviceId} node=${request.node} ${transferred.reason}`);
    deps.err(`Transfer failed: ${transferred.reason}. The request stays pending.`);
    return 1;
  }
  const grant = transferred.grant;
  store.grants.push(grant);
  approveConnectRequest(request, grant, deps.core.now());
  saveConnectStore(store);
  auditConnectGrant(grant);

  deps.out(`Granted: ${grant.id}  ${serviceId} -> ${grant.node} via ${grant.method} (${grant.delivery})`);
  if (grant.delivery === 'vaulted' && grant.secretName) {
    deps.out(`  Token vaulted in Phantom Secrets as ${grant.secretName}.`);
  }
  if (grant.delivery === 'operator-command' && transferred.operatorCommand) {
    deps.out(`  On node ${grant.node}, run the vendor login: ${transferred.operatorCommand}`);
  }
  if (grant.delivery === 'sealed-bundle' && grant.bundleFile) {
    deps.out(`  Sealed bundle: ~/.ashlr/connect/bundles/${grant.bundleFile} (key vaulted as ${grant.secretName}).`);
  }
  return 0;
}

async function cmdRevoke(deps: ConnectCliDeps, args: string[]): Promise<number> {
  const reason = takeOption(args, '--reason');
  const arg = args.shift();
  rejectLeftovers(args);
  if (!arg) throw new UsageError('Say what to revoke: phm connect revoke <grant-id|service>.');
  const store = loadConnectStore();
  let grant = findConnectGrant(store, arg);
  if (!grant && isConnectServiceId(arg)) {
    const matches = store.grants.filter((g) => g.service === arg && g.revokedAt === null);
    if (matches.length === 1) grant = matches[0]!;
    else if (matches.length > 1) {
      deps.err(`Multiple active grants for ${arg}; revoke by grant id.`);
      return 1;
    }
  }
  if (!grant) {
    deps.err(`No grant matches "${arg}".`);
    return 1;
  }
  if (grant.revokedAt !== null) {
    deps.err(`Grant ${grant.id} is already revoked.`);
    return 1;
  }
  deps.out(`  revoke grant ${grant.id}: ${grant.service} -> ${grant.node} (${grant.method}, ${grant.delivery})`);
  if (!(await deps.confirm('  Revoke it?'))) {
    deps.err('Not revoked.');
    return 1;
  }
  revokeConnectGrant(grant, deps.core.now(), reason);
  let secretNote = '';
  if (grant.secretName) {
    const removed = deps.core.removeSecret(grant.secretName);
    secretNote = removed.ok ? 'vault secret removed' : `vault secret could not be removed (${removed.reason ?? 'unavailable'})`;
  }
  if (grant.bundleFile) {
    removeSealedBundle(grant.bundleFile);
  }
  saveConnectStore(store);
  auditConnectRevoke(grant);
  deps.out(`Revoked ${grant.id}.${secretNote ? ` ${secretNote}.` : ''}`);
  return 0;
}

async function cmdWizard(deps: ConnectCliDeps, args: string[]): Promise<number> {
  const asJson = takeFlag(args, '--json');
  const nodeRaw = takeOption(args, '--node');
  rejectLeftovers(args);
  const node = resolveNodeId(nodeRaw, deps.core.hostname());
  if (node === null) throw new UsageError(`Invalid node id "${nodeRaw ?? ''}".`);

  const rows = discoverConnectAccounts(deps.core);
  const signedIn = rows.filter((r) => r.signedIn);
  if (signedIn.length === 0) {
    deps.out('No signed-in services detected on this machine.');
    return 0;
  }
  const store = loadConnectStore();
  const results: { service: string; outcome: string; grantId?: string }[] = [];
  for (const row of signedIn) {
    const serviceId = row.service;
    const existing = activeConnectGrant(store, serviceId, node);
    if (existing) {
      deps.out(`${serviceId}: already connected to ${node} (${existing.id}); skipping.`);
      results.push({ service: serviceId, outcome: 'already-connected', grantId: existing.id });
      continue;
    }
    for (const line of cardLines({
      service: serviceId,
      label: row.label,
      account: row.account,
      node,
      scopes: row.scopes,
      notes: row.notes,
    })) deps.out(line);
    // One explicit approval per account; nothing connects without it.
    if (!(await deps.confirm(`  Connect ${serviceId} to ${node}?`))) {
      deps.out(`  ${serviceId}: skipped.`);
      results.push({ service: serviceId, outcome: 'skipped' });
      continue;
    }
    const transferred = await runApprovedTransfer(deps, {
      service: serviceId,
      node,
      account: row.account,
      scopes: row.scopes,
    });
    if (!transferred.ok) {
      auditConnectRefusal('grant', `wizard service=${serviceId} node=${node} ${transferred.reason}`);
      deps.err(`  ${serviceId}: transfer failed: ${transferred.reason}.`);
      results.push({ service: serviceId, outcome: 'failed' });
      continue;
    }
    const grant = transferred.grant;
    store.grants.push(grant);
    saveConnectStore(store);
    auditConnectGrant(grant);
    deps.out(`  ${serviceId}: connected via ${grant.method} (${grant.delivery}) -> ${grant.id}`);
    if (grant.delivery === 'operator-command' && transferred.operatorCommand) {
      deps.out(`    on node ${grant.node}, run: ${transferred.operatorCommand}`);
    }
    results.push({ service: serviceId, outcome: 'connected', grantId: grant.id });
  }
  if (asJson) {
    json(deps, { node, results });
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const known = ['wizard', 'discover', 'status', 'requests', 'request', 'approve', 'deny', 'revoke'];

const HELP_VALUE_OPTIONS = new Set(['--node', '--scope', '--method', '--reason']);

function wantsHelp(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (HELP_VALUE_OPTIONS.has(arg)) { i += 1; continue; }
    if (arg === '--help' || arg === '-h') return true;
  }
  return false;
}

function isComplete(deps: Partial<ConnectCliDeps>): deps is ConnectCliDeps {
  return deps.core !== undefined && deps.confirm !== undefined &&
    deps.out !== undefined && deps.err !== undefined;
}

export async function runConnectCli(argv: string[], injected?: Partial<ConnectCliDeps>): Promise<number> {
  const args = [...argv];
  const print = injected?.out ?? ((line: string) => console.log(line));
  const printErr = injected?.err ?? ((line: string) => console.error(line));
  let sub = args.shift();
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    print(USAGE);
    return 0;
  }
  if (sub !== undefined && !known.includes(sub) && !sub.startsWith('-')) {
    printErr(`Unknown connect command "${sub}".\n\n${USAGE}`);
    return 2;
  }
  // `phm connect --node n` / `--json` is the wizard with options; a bare
  // `phm connect` is the wizard too.
  if (sub !== undefined && sub.startsWith('-')) {
    args.unshift(sub);
    sub = 'wizard';
  }
  // `--help` after any verb explains before any deps load and before any
  // store/subprocess side effect (the help-safety lane requires this).
  if (wantsHelp(args)) {
    print(USAGE);
    return 0;
  }
  const deps: ConnectCliDeps = injected && isComplete(injected)
    ? injected
    : { ...(await defaultDeps()), ...injected };
  try {
    switch (sub) {
      case undefined:
      case 'wizard': return await cmdWizard(deps, args);
      case 'discover': return cmdDiscover(deps, args);
      case 'status': return cmdStatus(deps, args);
      case 'requests': return cmdRequests(deps, args);
      case 'request': return await cmdRequest(deps, args);
      case 'approve': return await cmdApprove(deps, args);
      case 'deny': return await cmdDeny(deps, args);
      case 'revoke': return await cmdRevoke(deps, args);
      default: return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      deps.err(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    deps.err(`connect ${sub ?? 'wizard'} failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
