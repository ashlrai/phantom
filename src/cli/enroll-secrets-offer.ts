/**
 * Value-blind Phantom Secrets setup offer shown after `phm enroll add`.
 *
 * Preview-first and advisory only: it inspects Secrets project metadata and
 * prints the dry-run command to review before the operator runs the mutating
 * `phantom init` from a trusted terminal. It never executes a mutating
 * Secrets command and never reads secret values.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPhantomStatus } from '../core/phantom.js';
import type { PhantomStatus } from '../core/types.js';

export interface SecretsOfferDeps {
  status?: (cwd: string) => PhantomStatus;
  isDirectory?: (path: string) => boolean;
}

function defaultIsDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function secretsSetupOffer(repo: string, deps: SecretsOfferDeps = {}): string[] {
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  const dir = resolve(repo);
  if (!isDirectory(dir)) return [];
  const status = (deps.status ?? ((cwd: string) => getPhantomStatus({ cwd, timeoutMs: 5000 })))(dir);
  const q = shellQuote(dir);
  if (!status.installed) {
    return [
      'Phantom Secrets: not installed. Keep API keys out of agent context for this repo:',
      '  brew tap ashlrai/phantom && brew trust --formula ashlrai/phantom/phantom && brew install ashlrai/phantom/phantom',
      `  then preview: phantom init --all ${q} --dry-run`,
    ];
  }
  if (status.error) {
    return ['Phantom Secrets: project metadata status unverified; run `phm doctor` for details.'];
  }
  if (!status.initialized) {
    return [
      'Phantom Secrets: this repo is not protected yet. Preview first (no changes):',
      `  phantom init --all ${q} --dry-run`,
      `Then, from a trusted terminal: cd ${q} && phantom init`,
    ];
  }
  const count = status.secretNames.length;
  return [`Phantom Secrets: configured (${count} secret name${count === 1 ? '' : 's'}; values never read).`];
}
