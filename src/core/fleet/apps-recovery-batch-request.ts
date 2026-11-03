import { closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const limit = 16 * 1024;
export type RecoveryBatchRequest = { version: 1; invocationIds: string[]; root: string };

export function validateRecoveryBatchRequest(value: unknown): RecoveryBatchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid request');
  const request = value as Record<string, unknown>;
  if (Object.keys(request).sort().join(',') !== 'invocationIds,root,version' || request.version !== 1 ||
      typeof request.root !== 'string' || !request.root || request.root.includes('\0') ||
      !isAbsolute(request.root) || resolve(request.root) !== request.root ||
      !Array.isArray(request.invocationIds) || request.invocationIds.length < 1 || request.invocationIds.length > 20 ||
      request.invocationIds.some(id => typeof id !== 'string' || !uuid.test(id)) ||
      new Set(request.invocationIds).size !== request.invocationIds.length) throw new Error('invalid request');
  return request as RecoveryBatchRequest;
}

export function readRecoveryBatchRequest(path: string): RecoveryBatchRequest {
  const fd = openSync(path, 'r');
  try {
    if (!fstatSync(fd).isFile()) throw new Error('invalid request');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0, count: number;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    if (size > limit) throw new Error('request too large');
    return validateRecoveryBatchRequest(JSON.parse(buffer.subarray(0, size).toString('utf8')));
  } finally { closeSync(fd); }
}

export function writeRecoveryBatchRequest(path: string, request: RecoveryBatchRequest): void {
  writeFileSync(path, `${JSON.stringify(validateRecoveryBatchRequest(request))}\n`, { flag: 'wx', mode: 0o600 });
}
