import { scrubSecrets } from '../../util/scrub.js';
import { spawnSync } from 'node:child_process';

/** An explicit SSH config alias is the team device allowlist. Never accept shell syntax. */
export function validSshHost(host: unknown): host is string {
  return typeof host === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,99}$/.test(host);
}
export function sshApprovalStep(host: string): string {
  if (!validSshHost(host)) throw new Error('Invalid SSH host');
  return `On this Mac, Mason runs: ssh -o ForwardAgent=no -o StrictHostKeyChecking=ask ${host} true. Verify the host fingerprint. To install this Mac's public key once, Mason runs: ssh-copy-id ${host}. Then retry the join. Never copy provider auth directories.`;
}

/** Fixed remote command; request goes through stdin, not shell or argv. No key exchange,
 * agent forwarding, auth directories, stderr, provider output or environment dumps. */
export function callNodeSsh(host: string, request: unknown, run: typeof spawnSync = spawnSync): unknown {
  if (!validSshHost(host)) throw new Error('Invalid SSH host');
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 128 * 1024 || scrubSecrets(input) !== input) throw new Error('Node request too large');
  const child = run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=5', '--', host,
    'phm node rpc --json'], { input, encoding: 'utf8', timeout: 12_000, maxBuffer: 20 * 1024 * 1024,
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'] }, stdio: ['pipe', 'pipe', 'pipe'] });
  if (child.error || child.status !== 0) throw new Error('Node SSH unavailable; complete the printed device approval step');
  try { return JSON.parse(child.stdout); } catch { throw new Error('Invalid node SSH reply'); }
}
