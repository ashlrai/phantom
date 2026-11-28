import { scrubSecrets } from '../../util/scrub.js';
import { execFile, spawnSync } from 'node:child_process';

/** An explicit SSH config alias is the team device allowlist. Never accept shell syntax. */
export function validSshHost(host: unknown): host is string {
  return typeof host === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,99}$/.test(host);
}
export function sshApprovalStep(host: string): string {
  if (!validSshHost(host)) throw new Error('Invalid SSH host');
  return `On this computer, run: ssh -o ForwardAgent=no -o StrictHostKeyChecking=ask ${host} true and verify the host fingerprint. To enroll this computer's public key once, run: ssh-copy-id ${host}. ${host} must have Phantom installed with phm on the SSH PATH. Then retry the join. Never copy provider auth directories.`;
}

/** Fixed remote command; request goes through stdin, not shell or argv. No key exchange,
 * agent forwarding, auth directories, stderr, provider output or environment dumps. */
function nodeSshInvocation(host: string, request: unknown) {
  if (!validSshHost(host)) throw new Error('Invalid SSH host');
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 128 * 1024 || scrubSecrets(input) !== input) throw new Error('Node request too large');
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=5', '--', host,
    'phm node rpc --json'];
  return { args, input, env: { PATH: process.env['PATH'], HOME: process.env['HOME'] } };
}

export function callNodeSsh(host: string, request: unknown, run: typeof spawnSync = spawnSync): unknown {
  const { args, input, env } = nodeSshInvocation(host, request);
  const child = run('ssh', args, { input, encoding: 'utf8', timeout: 12_000, maxBuffer: 20 * 1024 * 1024,
    env, stdio: ['pipe', 'pipe', 'pipe'] });
  if (child.error || child.status !== 0) throw new Error('Node SSH unavailable; complete the printed device approval step');
  try { return JSON.parse(child.stdout); } catch { throw new Error('Invalid node SSH reply'); }
}

export async function callNodeSshReadOnly(
  host: string, request: unknown, maxBuffer: number, options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  const { args, input, env } = nodeSshInvocation(host, request);
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', args, { encoding: 'utf8', timeout: options.timeoutMs ?? 12_000,
      signal: options.signal, killSignal: 'SIGKILL', maxBuffer, env }, (error, stdout) => {
      if (error) { reject(new Error('Node SSH unavailable')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid node SSH reply')); }
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}
