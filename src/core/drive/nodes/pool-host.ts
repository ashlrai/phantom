import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../../cloud/store.js';
import { privateDirectory } from '../../universe/artifacts.js';
import { readStableRegularFile } from '../../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../../util/private-file-write.js';
import { LocalNodesStore } from './local-store.js';
import { executePool, initializePool, poolSnapshot, type PoolReply, type PoolRequest } from './pool.js';
import { callNodeSsh, validSshHost } from './ssh.js';
import { validId } from './state.js';

export interface PoolConfig {
  role: 'primary' | 'backup' | 'worker';
  primary: string;
  backup: string;
  owner: string;
  node: string;
}
export function poolDirectory(): string { return privateDirectory(join(ashlrHome(), 'node-pool')); }
function writePrivate(name: string, value: unknown): void {
  const root = poolDirectory();
  writePrivateFileAtomically(join(root, `${name}.${randomUUID()}.tmp`), join(root, name), JSON.stringify(value) + '\n',
    { anchorPath: root, label: 'Node pool state' });
}
export function readPoolConfig(): PoolConfig | null {
  const root = poolDirectory(), path = join(root, 'config.json');
  if (!existsSync(path)) return null;
  const read = readStableRegularFile(path, { anchorPath: root, maxFileBytes: 4096, remainingBytes: 4096 });
  if (!read.ok) throw new Error('Invalid node pool config');
  const config: PoolConfig = JSON.parse(read.text);
  if (!config || !['primary', 'backup', 'worker'].includes(config.role) || !validSshHost(config.primary) ||
      !validSshHost(config.backup) || config.primary === config.backup || !validId(config.owner) || !validId(config.node) ||
      Object.keys(config).sort().join() !== 'backup,node,owner,primary,role') throw new Error('Invalid node pool config');
  return config;
}
export function configurePool(config: PoolConfig): void {
  if (!['primary', 'backup', 'worker'].includes(config.role) || !validSshHost(config.primary) || !validSshHost(config.backup) ||
      config.primary === config.backup || !validId(config.node) || !validId(config.owner)) throw new Error('Invalid node pool config');
  if (readPoolConfig()) throw new Error('Node pool already configured; never reset an active witness');
  if (config.role === 'backup') initializePool(new LocalNodesStore(poolDirectory()), config.primary, config.backup);
  writePrivate('config.json', config);
}

export interface NodeRpcRequest { kind: 'client' | 'witness'; request: PoolRequest }
export type NodeSsh = (host: string, request: unknown) => unknown;
export function parsePoolReply(value: unknown): PoolReply {
  const r = value as PoolReply;
  if (!r || r.schemaVersion !== 1 || !['primary', 'backup'].includes(r.active) || !Number.isSafeInteger(r.epoch) ||
      r.epoch < 1 || typeof r.demoted !== 'boolean' || !r.result || typeof r.result !== 'object') throw new Error('Invalid node pool reply');
  return r;
}

/** SSH is the device trust boundary. Only explicitly approved team SSH aliases are configured.
 * The witness never sends provider output or auth; primary stores a non-executable mirror.
 */
export function serveNodeRpc(config: PoolConfig, envelope: NodeRpcRequest, ssh: NodeSsh = callNodeSsh): unknown {
  if (!envelope || !['client', 'witness'].includes(envelope.kind) || !envelope.request || config.role === 'worker') {
    throw new Error('Invalid node RPC request');
  }
  if (config.role === 'primary') {
    if (envelope.kind !== 'client') throw new Error('Invalid node RPC destination');
    const response = ssh(config.backup, { kind: 'witness', request: { ...envelope.request, origin: 'primary' } }) as
      { reply: PoolReply; snapshot: unknown };
    const result = parsePoolReply(response?.reply);
    // Evidence only. There is deliberately no path that loads this as authority.
    writePrivate('primary-mirror.json', response.snapshot);
    return result;
  }
  const store = new LocalNodesStore(poolDirectory());
  const request = { ...envelope.request, origin: envelope.kind === 'witness' ? 'primary' as const : 'backup' as const };
  const result = executePool(store, request, config.owner);
  return envelope.kind === 'witness' ? { reply: result, snapshot: poolSnapshot(store) } : result;
}

export function callPool(config: PoolConfig, verb: string, args: string[], ssh: NodeSsh = callNodeSsh): PoolReply {
  const request: NodeRpcRequest = { kind: 'client', request: { origin: 'primary', action: 'execute', verb, args } };
  try {
    const result = config.role === 'primary' ? serveNodeRpc(config, request, ssh) : ssh(config.primary, request);
    const parsed = parsePoolReply(result);
    if (!parsed.demoted || config.role === 'primary') return parsed;
  } catch {
    if (config.role === 'primary') throw new Error('Witness unavailable; primary admission is closed');
    // An uncertain completion is safe to retry: the existing claim token fences it,
    // join refuses duplicate sessions and enqueue deduplicates IDs.
  }
  return parsePoolReply(config.role === 'backup' ? serveNodeRpc(config, request, ssh) : ssh(config.backup, request));
}
