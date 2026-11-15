/**
 * `phm caps` operations: list, validate, generate. The CLI parses argv and
 * prints; everything that decides paths or touches files lives here, with
 * cwd and home injectable so tests stay hermetic.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateCapsAdapters } from './generate.js';
import { checkCapsBundle, findRepoRoot, pinStageRoot, writeCapsBundle, type DriftResult } from './output.js';
import {
  CapsRegistryError,
  DEFAULT_CAPS_REGISTRY_PATH,
  readCapsRegistryFile,
  surfaceModelPairs,
  validateCapsRegistry,
  type CapsIssue,
  type CapsPair,
} from './registry.js';
import type { CapsRegistry } from './schema.js';

export const REGISTRY_REL_PATH = join('capabilities', 'registry.v1.json');
export const GENERATED_REL_PATH = join('capabilities', 'generated');

export interface CapsEnv {
  cwd?: string;
  home?: string;
}

/** Explicit path, else the current repo's registry, else the packaged one. */
export function resolveRegistryPath(explicit: string | undefined, env: CapsEnv = {}): string {
  if (explicit) return explicit;
  const root = findRepoRoot(env.cwd ?? process.cwd());
  const local = root ? join(root, REGISTRY_REL_PATH) : null;
  return local && existsSync(local) ? local : DEFAULT_CAPS_REGISTRY_PATH;
}

export type CapsValidateResult =
  | { ok: true; registryPath: string; counts: Record<string, number> }
  | { ok: false; registryPath: string; issues: CapsIssue[] };

async function load(registryPath: string): Promise<{ ok: true; registry: CapsRegistry } | { ok: false; issues: CapsIssue[] }> {
  let value: unknown;
  try {
    ({ value } = await readCapsRegistryFile(registryPath));
  } catch (error) {
    if (error instanceof CapsRegistryError) return { ok: false, issues: error.issues };
    return { ok: false, issues: [{ path: '(file)', message: 'Registry file could not be read. Run inside a Phantom checkout or pass --registry <path>.' }] };
  }
  const result = validateCapsRegistry(value);
  return result.ok ? { ok: true, registry: result.registry } : { ok: false, issues: result.issues };
}

function counts(reg: CapsRegistry): Record<string, number> {
  return {
    surfaces: reg.surfaces.length,
    models: reg.models.length,
    hosting: reg.hosting.length,
    sessions: reg.sessions.length,
    accounts: reg.accounts.length,
    capabilities: reg.capabilities.length,
    pairs: surfaceModelPairs(reg).length,
  };
}

export async function capsValidate(opts: { registry?: string } & CapsEnv = {}): Promise<CapsValidateResult> {
  const registryPath = resolveRegistryPath(opts.registry, opts);
  const loaded = await load(registryPath);
  return loaded.ok ? { ok: true, registryPath, counts: counts(loaded.registry) } : { ok: false, registryPath, issues: loaded.issues };
}

export interface CapsListView {
  ok: true;
  registryPath: string;
  surfaces: Array<{ id: string; kind: string; lane: string; adapter: string; hostedOnly: boolean; hosts: string[] }>;
  models: Array<{ id: string; lane: string; catalogId: string | null; allowance: string | null }>;
  pairs: CapsPair[];
  sessions: Array<{ id: string; surface: string; model: string; role: string }>;
  accounts: Array<{ id: string; provider: string; store: string; credentialName: string | null; scopes: string[] }>;
  capabilities: Array<{ id: string; kind: string; surfaces: string[]; flags: string[]; hardLimitGates: string[] }>;
}

export async function capsList(opts: { registry?: string } & CapsEnv = {}): Promise<CapsListView | { ok: false; registryPath: string; issues: CapsIssue[] }> {
  const registryPath = resolveRegistryPath(opts.registry, opts);
  const loaded = await load(registryPath);
  if (!loaded.ok) return { ok: false, registryPath, issues: loaded.issues };
  const reg = loaded.registry;
  return {
    ok: true,
    registryPath,
    surfaces: reg.surfaces.map((s) => ({ id: s.id, kind: s.kind, lane: s.lane, adapter: s.adapter, hostedOnly: s.hostedOnly, hosts: reg.hosting.filter((e) => e.guest === s.id).map((e) => e.host).sort() })),
    models: reg.models.map((m) => ({ id: m.id, lane: m.lane, catalogId: m.catalogId, allowance: m.allowance ?? null })),
    pairs: surfaceModelPairs(reg),
    sessions: reg.sessions.map((s) => ({ id: s.id, surface: s.surface, model: s.model, role: s.role })),
    accounts: reg.accounts.map((a) => ({ id: a.id, provider: a.provider, store: a.store, credentialName: a.credentialName, scopes: a.scopes })),
    capabilities: reg.capabilities.map((c) => ({
      id: c.id,
      kind: c.kind,
      surfaces: c.surfaces,
      flags: (['external_send', 'spend', 'delete'] as const).filter((f) => c.sensitivity[f]),
      hardLimitGates: c.hardLimitGates,
    })),
  };
}

export type CapsGenerateResult =
  | { ok: true; mode: 'write'; registryPath: string; outDir: string; bundleSha256: string; registrySha256: string; written: string[]; removed: string[] }
  | { ok: boolean; mode: 'check'; registryPath: string; outDir: string; bundleSha256: string; registrySha256: string; drift: DriftResult }
  | { ok: false; mode: 'write' | 'check'; registryPath: string; issues: CapsIssue[] };

export interface CapsGenerateOptions extends CapsEnv {
  registry?: string;
  out?: string;
  check?: boolean;
  /** Stage under ~/.ashlr-runs/staged/caps/<bundleSha256>/ for pin-stage. */
  pinStage?: boolean;
}

export async function capsGenerate(opts: CapsGenerateOptions = {}): Promise<CapsGenerateResult> {
  const mode = opts.check ? 'check' : 'write';
  const registryPath = resolveRegistryPath(opts.registry, opts);
  const loaded = await load(registryPath);
  if (!loaded.ok) return { ok: false, mode, registryPath, issues: loaded.issues };
  const bundle = generateCapsAdapters(loaded.registry);
  const home = opts.home ?? homedir();
  const repoRoot = findRepoRoot(opts.cwd ?? process.cwd());

  let outDir: string;
  if (opts.pinStage) outDir = join(pinStageRoot(home), 'caps', bundle.bundleSha256);
  else if (opts.out) outDir = opts.out;
  else if (repoRoot) outDir = join(repoRoot, GENERATED_REL_PATH);
  else return { ok: false, mode, registryPath, issues: [{ path: '(out)', message: 'Not inside a repository: pass --out <dir> under a worktree, or --pin-stage.' }] };

  const sums = { bundleSha256: bundle.bundleSha256, registrySha256: bundle.registrySha256 };
  if (mode === 'check') {
    const drift = await checkCapsBundle(bundle, outDir);
    return { ok: drift.ok, mode, registryPath, outDir, ...sums, drift };
  }
  // With no repo, the only writable root is the pin-stage directory.
  const written = await writeCapsBundle(bundle, outDir, { repoRoot: repoRoot ?? pinStageRoot(home), home });
  return { ok: true, mode, registryPath, outDir: written.outDir, ...sums, written: written.written, removed: written.removed };
}
