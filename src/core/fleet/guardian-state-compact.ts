import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  guardianVerificationKey,
  readGuardianManifest,
  readGuardianState,
  writePrivateExclusive,
  type GuardianState,
} from './guardian-schema.js';

export interface GuardianCompactOptions { manifest: string; sourceState: string; outputState: string }
export interface GuardianCompactResult { before: number; retained: number; removed: number }

async function canonicalExisting(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return realpath(path).catch(() => { throw new Error(`${label} missing or unreadable`); });
}

/** Compact a guardian state to entries whose key is in the manifest. Pure read of inputs; output created 0600 exclusively. */
export async function compactGuardianState(options: GuardianCompactOptions): Promise<GuardianCompactResult> {
  const manifestPath = await canonicalExisting(options.manifest, 'manifest');
  const sourcePath = await canonicalExisting(options.sourceState, 'source state'); // missing state is an error, never emptied
  if (!isAbsolute(options.outputState)) throw new Error('output state must be absolute');
  const outputPath = join(await realpath(dirname(options.outputState)).catch(() => { throw new Error('output directory missing or unreadable'); }), basename(options.outputState));
  if (sourcePath === outputPath || manifestPath === outputPath || manifestPath === sourcePath) throw new Error('manifest, source and output paths must be distinct');
  if (await lstat(outputPath).then(() => true, (err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; return false; })) throw new Error('output already exists');
  const keys = new Set((await readGuardianManifest(manifestPath)).map(guardianVerificationKey));
  const state = await readGuardianState(sourcePath);
  const entries = state.entries.filter(e => keys.has(e.key)); // order and values preserved unchanged
  const output: GuardianState = { version: 1, entries };
  await writePrivateExclusive(outputPath, JSON.stringify(output));
  return { before: state.entries.length, retained: entries.length, removed: state.entries.length - entries.length };
}
