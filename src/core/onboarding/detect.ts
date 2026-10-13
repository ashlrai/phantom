/**
 * core/onboarding/detect.ts — smart defaults for the setup wizard: which
 * companion executables and resource CLIs are on PATH. Stats files only;
 * never executes anything, never reads config or credentials.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { COMPANION_MANIFEST, type CompanionId } from '../ecosystem/companion-manifest.js';
import type { ResourceKind } from './resources-model.js';

export function onPath(binary: string, pathEnv = process.env.PATH ?? ''): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const p = join(dir, binary + ext);
      try {
        if (statSync(p).isFile()) {
          accessSync(p, constants.X_OK);
          return p;
        }
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

const RESOURCE_BINARIES: Partial<Record<ResourceKind, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  grok: 'grok',
  ollama: 'ollama',
  'lm-studio': 'lms',
};

export interface Detection {
  companions: Partial<Record<CompanionId, string>>;
  resources: Partial<Record<ResourceKind, string>>;
}

export function detectInstalled(pathEnv = process.env.PATH ?? ''): Detection {
  const companions: Detection['companions'] = {};
  for (const c of COMPANION_MANIFEST) {
    if (!c.executable) continue;
    const hit = onPath(c.executable, pathEnv);
    if (hit) companions[c.id] = hit;
  }
  const resources: Detection['resources'] = {};
  for (const [kind, bin] of Object.entries(RESOURCE_BINARIES) as Array<[ResourceKind, string]>) {
    const hit = onPath(bin, pathEnv);
    if (hit) resources[kind] = hit;
  }
  return { companions, resources };
}
