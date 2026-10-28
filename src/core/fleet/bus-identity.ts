import { execFile } from 'node:child_process';

export interface BusPeer {
  id: string;
  source: 'local' | 'locus';
}

const PEER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const MAX_PEERS = 4_096;

function validId(value: unknown): value is string {
  // Comparing the whole match also rejects the trailing newline accepted by `$`.
  return typeof value === 'string' && PEER_ID.exec(value)?.[0] === value;
}

function peerIds(value: unknown, field: 'id' | 'session_id' = 'id'): Array<{ id: string }> {
  if (!Array.isArray(value) || value.length > MAX_PEERS) {
    throw new Error('Locus bus peer registry is invalid');
  }
  const seen = new Set<string>();
  return value.map((peer: unknown) => {
    if (peer === null || typeof peer !== 'object' || Array.isArray(peer)) {
      throw new Error('Locus bus peer registry is invalid');
    }
    const id = (peer as Record<string, unknown>)[field];
    if (!validId(id) || seen.has(id)) throw new Error('Locus bus peer registry is invalid');
    seen.add(id);
    // Only the identifier leaves this adapter; provider metadata is private.
    return { id };
  });
}

/** Peer identity is a routing label, never a fleet execution capability. */
export function resolveBusPeer(id: string, peers?: readonly { id: string }[] | null): BusPeer {
  if (!validId(id)) throw new Error('Invalid bus peer identifier');
  if (peers === undefined || peers === null) return { id, source: 'local' };
  if (!peerIds(peers).some((peer) => peer.id === id)) {
    throw new Error('Bus peer is absent from the Locus registry');
  }
  return { id, source: 'locus' };
}

/**
 * Optional read-only probe of Locus's `locus.peers.v1` discovery contract
 * (locus-cli/src/peers.rs and json_out.rs, RQ-PLAN-LOCUS-PEERS-A).
 * session_id is a public routing label, not a sealed-session capability.
 * Unknown schemas fail closed; absence/unsupported commands allow local IDs.
 * Do not infer identities from arbitrary status, session, or provider output.
 */
export async function loadLocusBusPeers(): Promise<readonly { id: string }[] | null> {
  const result = await new Promise<{
    code: string | number;
    stdout: string;
    stderr: string;
    killed: boolean;
  }>((resolve) => {
    execFile('locus', ['peers', 'list', '--json'], {
      shell: false,
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 256 * 1_024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 'FAILED' : 0, stdout, stderr, killed: error?.killed === true });
    });
  });
  if (result.code === 'ENOENT') return null;
  if (result.code === 2 && !result.killed &&
    /^error: (?:unrecognized|unknown) subcommand ['"`]peers['"`](?:\r?\n|$)/m.test(result.stderr)) {
    return null;
  }
  if (result.code !== 0 || result.killed) throw new Error('Locus bus peer discovery failed');
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error('Locus bus peer registry is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    (value as Record<string, unknown>)['schema'] !== 'locus.peers.v1') {
    throw new Error('Unsupported Locus bus peer registry schema');
  }
  return peerIds((value as Record<string, unknown>)['peers'], 'session_id');
}
