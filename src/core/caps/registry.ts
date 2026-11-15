/**
 * Capability registry loader, validator and router-facing queries.
 *
 * `validateCapsRegistry` is the single gate: it screens the raw document for
 * secret-shaped text BEFORE parsing (so no diagnostic can echo a value), parses
 * the closed schema, then checks every cross-reference against the registry
 * itself and against the router's existing sources of truth (engine registry,
 * model catalog). Diagnostics carry a path and a sentence, never input values.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertMetadata } from '../connectors/profile.js';
import { BUILTIN_ENGINE_REGISTRY } from '../run/engine-registry.js';
import { KNOWN_MODELS } from '../run/model-catalog.js';
import {
  BROWSER_CONTROL_BACKENDS,
  CONTROL_BACKENDS,
  EFFECT_IMPLIES,
  FORBIDDEN_CONTROL_BACKENDS,
  HARD_LIMIT_GATE_FOR,
  SENSITIVITY_FLAGS,
  capsRegistrySchema,
  type CapsModel,
  type CapsRegistry,
  type CapsSurface,
  type ControlBackend,
} from './schema.js';

/**
 * The in-repo registry. Resolves from both `src/core/caps/` and `dist/core/caps/`.
 * Not in the published package's `files` allowlist: `phm caps` is a checkout tool.
 */
export const DEFAULT_CAPS_REGISTRY_PATH = fileURLToPath(new URL('../../../capabilities/registry.v1.json', import.meta.url));

export interface CapsIssue {
  /** Dotted location, e.g. `capabilities[3].hardLimitGates`. */
  path: string;
  message: string;
}

export type CapsValidation =
  | { ok: true; registry: CapsRegistry; issues: [] }
  | { ok: false; registry: null; issues: CapsIssue[] };

export class CapsRegistryError extends Error {
  constructor(readonly issues: CapsIssue[]) {
    super(`Capability registry is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'}): ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  }
}

const pathOf = (parts: readonly PropertyKey[]): string =>
  parts.reduce<string>((acc, part) => typeof part === 'number' ? `${acc}[${part}]` : acc ? `${acc}.${String(part)}` : String(part), '') || '(root)';

/** Validate an already-parsed document. Pure: no I/O. */
export function validateCapsRegistry(value: unknown): CapsValidation {
  // Secret screen first, on the raw text, so neither zod nor our own
  // messages can ever quote a value that looked like a credential.
  try {
    assertMetadata(JSON.stringify(value) ?? '');
  } catch {
    return { ok: false, registry: null, issues: [{ path: '(root)', message: 'Secret-shaped text refused. The registry holds credential names and scopes only.' }] };
  }
  const forbidden = forbiddenBackendIssues(value);
  const parsed = capsRegistrySchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: pathOf(issue.path), message: issue.message }));
    return { ok: false, registry: null, issues: [...forbidden, ...issues.filter((i) => !forbidden.some((f) => f.path === i.path))] };
  }
  const issues = [...forbidden, ...semanticIssues(parsed.data)];
  return issues.length ? { ok: false, registry: null, issues } : { ok: true, registry: parsed.data, issues: [] };
}

/** Named refusals for TCC / app-DB / scrape backends, reported before generic schema errors. */
function forbiddenBackendIssues(value: unknown): CapsIssue[] {
  const caps = (value as { capabilities?: unknown })?.capabilities;
  if (!Array.isArray(caps)) return [];
  return caps.flatMap((cap, i) => {
    const backend = (cap as { control?: { backend?: unknown } })?.control?.backend;
    if (typeof backend !== 'string' || !Object.hasOwn(FORBIDDEN_CONTROL_BACKENDS, backend)) return [];
    return [{ path: `capabilities[${i}].control.backend`, message: `Control backend "${backend}" is refused: it ${FORBIDDEN_CONTROL_BACKENDS[backend]}. Use AX, AppleScript/JXA, Shortcuts, an app CLI, a URL scheme or loopback CDP/Playwright with a per-run profile.` }];
  });
}

function duplicates<T extends { id: string }>(items: readonly T[], label: string, add: (path: string, message: string) => void): Set<string> {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.id)) add(`${label}[${i}].id`, `Duplicate ${label} id "${item.id}".`);
    seen.add(item.id);
  });
  return seen;
}

function catalogTag(id: string): string {
  return id.slice(id.indexOf(':') + 1);
}

function semanticIssues(reg: CapsRegistry): CapsIssue[] {
  const issues: CapsIssue[] = [];
  const add = (path: string, message: string): void => { issues.push({ path, message }); };

  const surfaceIds = duplicates(reg.surfaces, 'surfaces', add);
  const modelIds = duplicates(reg.models, 'models', add);
  const accountIds = duplicates(reg.accounts, 'accounts', add);
  const capIds = duplicates(reg.capabilities, 'capabilities', add);
  duplicates(reg.sessions, 'sessions', add);
  const egressIds = duplicates(reg.egressAllowlists, 'egressAllowlists', add);
  // Surfaces and models share the router's pair namespace; one id must not name both.
  for (const id of surfaceIds) if (modelIds.has(id)) add('models', `Id "${id}" names both a surface and a model; surfaces and models are distinct.`);

  const surfaces = new Map(reg.surfaces.map((s) => [s.id, s]));
  const lanes = new Set(reg.surfaces.map((s) => s.lane));
  const catalog = new Map(KNOWN_MODELS.map((m) => [m.id, m]));

  reg.surfaces.forEach((s, i) => {
    const at = `surfaces[${i}]`;
    if (s.engine !== undefined && !Object.hasOwn(BUILTIN_ENGINE_REGISTRY, s.engine)) {
      add(`${at}.engine`, `Engine "${s.engine}" is not in run/engine-registry.ts; the registry never invents engines.`);
    }
    if (s.kind === 'local-runtime' && !s.network) add(`${at}.network`, 'Local model surfaces must declare bind 127.0.0.1, keyForwarding false and an egress allowlist reference.');
    if (s.kind !== 'local-runtime' && s.network) add(`${at}.network`, 'Only local-runtime surfaces declare a loopback network policy.');
    if (s.network && !egressIds.has(s.network.egressAllowlistRef)) add(`${at}.network.egressAllowlistRef`, `Egress allowlist "${s.network.egressAllowlistRef}" is not defined.`);
    if ((s.adapter === 'local-model') !== (s.kind === 'local-runtime')) add(`${at}.adapter`, 'The local-model adapter is for local-runtime surfaces, and local-runtime surfaces use it.');
  });

  reg.models.forEach((m, i) => {
    const at = `models[${i}]`;
    if (!lanes.has(m.lane)) add(`${at}.lane`, `No surface serves lane "${m.lane}".`);
    if (m.catalogId === null) return;
    const entry = catalog.get(m.catalogId);
    if (!entry) { add(`${at}.catalogId`, `"${m.catalogId}" is not in run/model-catalog.ts KNOWN_MODELS.`); return; }
    const providerId = entry.apiModelId ?? catalogTag(entry.id);
    if (providerId !== m.providerModelId) add(`${at}.providerModelId`, `Catalog entry "${m.catalogId}" names provider model "${providerId}".`);
  });

  // Hosting edges: both ends exist, no self/duplicate edges, acyclic, and every
  // hosted-only surface is reachable through at least one host.
  const edgeKeys = new Set<string>();
  reg.hosting.forEach((e, i) => {
    const at = `hosting[${i}]`;
    if (!surfaceIds.has(e.host)) add(`${at}.host`, `Unknown host surface "${e.host}".`);
    if (!surfaceIds.has(e.guest)) add(`${at}.guest`, `Unknown guest surface "${e.guest}".`);
    if (e.host === e.guest) add(at, 'A surface cannot host itself.');
    const key = `${e.host}>${e.guest}`;
    if (edgeKeys.has(key)) add(at, `Duplicate hosting edge ${e.host} -> ${e.guest}.`);
    edgeKeys.add(key);
    if (surfaces.get(e.host)?.hostedOnly) add(`${at}.host`, `Hosted-only surface "${e.host}" cannot host others.`);
  });
  reg.surfaces.forEach((s, i) => {
    if (s.hostedOnly && !reg.hosting.some((e) => e.guest === s.id)) add(`surfaces[${i}].hostedOnly`, `Hosted-only surface "${s.id}" has no hosting edge.`);
  });

  reg.accounts.forEach((a, i) => {
    if (a.credentialName === null && a.store !== 'host-session') add(`accounts[${i}].credentialName`, 'Only host-session accounts may omit a credential name.');
  });

  reg.capabilities.forEach((c, i) => {
    const at = `capabilities[${i}]`;
    c.surfaces.forEach((s, j) => { if (!surfaceIds.has(s)) add(`${at}.surfaces[${j}]`, `Unknown surface "${s}".`); });
    c.accounts.forEach((a, j) => { if (!accountIds.has(a)) add(`${at}.accounts[${j}]`, `Unknown account "${a}".`); });

    for (const effect of c.effects) {
      const flag = EFFECT_IMPLIES[effect];
      if (flag && !c.sensitivity[flag]) add(`${at}.sensitivity.${flag}`, `Effect "${effect}" requires sensitivity.${flag} = true.`);
    }
    for (const flag of SENSITIVITY_FLAGS) {
      const gate = HARD_LIMIT_GATE_FOR[flag];
      if (c.sensitivity[flag] && !c.hardLimitGates.includes(gate)) add(`${at}.hardLimitGates`, `sensitivity.${flag} requires hard-limit gate "${gate}".`);
    }

    if (c.control) {
      const backend = c.control.backend;
      if (!Object.hasOwn(FORBIDDEN_CONTROL_BACKENDS, backend)) {
        if (!(CONTROL_BACKENDS as readonly string[]).includes(backend)) {
          add(`${at}.control.backend`, `Unknown control backend "${backend}"; allowed: ${CONTROL_BACKENDS.join(', ')}.`);
        } else if (BROWSER_CONTROL_BACKENDS.has(backend as ControlBackend)) {
          if (c.control.profile !== 'per-run' || c.control.bind !== '127.0.0.1') add(`${at}.control`, 'CDP/Playwright control requires profile "per-run" and bind 127.0.0.1.');
        } else if (c.control.profile !== undefined || c.control.bind !== undefined) {
          add(`${at}.control`, 'profile and bind apply only to loopback CDP/Playwright backends.');
        }
      }
    }

    if (c.launch) {
      if (c.kind !== 'mcp' && c.kind !== 'cli') add(`${at}.launch`, 'Only MCP and CLI capabilities have a launch spec.');
      const names = new Set<string>();
      c.launch.env.forEach((e, j) => {
        if (names.has(e.name)) add(`${at}.launch.env[${j}].name`, `Duplicate environment variable "${e.name}".`);
        names.add(e.name);
        if (!c.accounts.includes(e.account)) add(`${at}.launch.env[${j}].account`, `Account "${e.account}" must be listed in the capability's accounts.`);
      });
    }
    if (c.kind === 'mcp' && !c.launch) add(`${at}.launch`, 'MCP capabilities need a launch spec for adapter generation.');
  });

  reg.sessions.forEach((s, i) => {
    const at = `sessions[${i}]`;
    const pair = resolvePairIn(reg, s.surface, s.model);
    if (!pair.ok) add(at, pair.reason);
    s.capabilities.forEach((c, j) => {
      if (!capIds.has(c)) { add(`${at}.capabilities[${j}]`, `Unknown capability "${c}".`); return; }
      const cap = reg.capabilities.find((x) => x.id === c)!;
      if (!cap.surfaces.includes(s.surface)) add(`${at}.capabilities[${j}]`, `Capability "${c}" is not enabled on surface "${s.surface}".`);
    });
  });

  const cycle = findHostingCycle(reg);
  if (cycle) add('hosting', `Hosting edges form a cycle: ${cycle.join(' -> ')}.`);
  return issues;
}

function findHostingCycle(reg: Pick<CapsRegistry, 'hosting'>): string[] | null {
  const next = new Map<string, string[]>();
  for (const e of reg.hosting) next.set(e.host, [...(next.get(e.host) ?? []), e.guest]);
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'open') return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, 'open');
    stack.push(node);
    for (const guest of next.get(node) ?? []) {
      const found = visit(guest);
      if (found) return found;
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };
  for (const host of [...next.keys()].sort()) {
    const found = visit(host);
    if (found) return found;
  }
  return null;
}

/** Parse and validate; throws `CapsRegistryError` with every issue. */
export function parseCapsRegistry(value: unknown): CapsRegistry {
  const result = validateCapsRegistry(value);
  if (!result.ok) throw new CapsRegistryError(result.issues);
  return result.registry;
}

/** Read a registry file. JSON syntax errors are reported without echoing file content. */
export async function readCapsRegistryFile(path: string = DEFAULT_CAPS_REGISTRY_PATH): Promise<{ raw: string; value: unknown }> {
  const raw = await readFile(path, 'utf8');
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch {
    throw new CapsRegistryError([{ path: '(root)', message: 'Registry file is not valid JSON.' }]);
  }
}

export async function loadCapsRegistry(path: string = DEFAULT_CAPS_REGISTRY_PATH): Promise<CapsRegistry> {
  return parseCapsRegistry((await readCapsRegistryFile(path)).value);
}

// ---------------------------------------------------------------------------
// Router-facing queries
// ---------------------------------------------------------------------------

export interface CapsPair {
  surface: string;
  model: string;
  /** Router catalog id, when Phantom routes this model. */
  catalogId: string | null;
  /** Hosts that must be traversed to reach the surface, outermost first. Empty = direct. */
  via: string[];
}

export type PairResolution = { ok: true; pair: CapsPair } | { ok: false; reason: string };

/** Hosts reaching `surfaceId`, outermost first (shortest path; ties broken by id). */
function hostPath(reg: Pick<CapsRegistry, 'hosting' | 'surfaces'>, surfaceId: string): string[] | null {
  const target = reg.surfaces.find((s) => s.id === surfaceId);
  if (!target) return null;
  if (!target.hostedOnly) return [];
  const queue: Array<{ node: string; path: string[] }> = [{ node: surfaceId, path: [] }];
  const seen = new Set([surfaceId]);
  while (queue.length) {
    const { node, path } = queue.shift()!;
    const hosts = reg.hosting.filter((e) => e.guest === node).map((e) => e.host).sort();
    for (const host of hosts) {
      if (seen.has(host)) continue;
      seen.add(host);
      const route = [host, ...path];
      if (!reg.surfaces.find((s) => s.id === host)?.hostedOnly) return route;
      queue.push({ node: host, path: route });
    }
  }
  return null;
}

function resolvePairIn(reg: CapsRegistry, surfaceId: string, modelId: string): PairResolution {
  const surface: CapsSurface | undefined = reg.surfaces.find((s) => s.id === surfaceId);
  if (!surface) return { ok: false, reason: `Unknown surface "${surfaceId}".` };
  const model: CapsModel | undefined = reg.models.find((m) => m.id === modelId);
  if (!model) {
    const asSurface = reg.surfaces.some((s) => s.id === modelId);
    return { ok: false, reason: asSurface ? `"${modelId}" is a surface, not a model.` : `Unknown model "${modelId}".` };
  }
  if (model.lane !== surface.lane) return { ok: false, reason: `Model "${modelId}" (lane ${model.lane}) does not run on surface "${surfaceId}" (lane ${surface.lane}).` };
  const via = hostPath(reg, surfaceId);
  if (via === null) return { ok: false, reason: `Surface "${surfaceId}" is hosted-only and no host reaches it.` };
  return { ok: true, pair: { surface: surfaceId, model: modelId, catalogId: model.catalogId, via } };
}

/** Validate one `(surface, model)` pair the router proposes. */
export function resolveSurfaceModelPair(reg: CapsRegistry, surfaceId: string, modelId: string): PairResolution {
  return resolvePairIn(reg, surfaceId, modelId);
}

/** Every routable `(surface, model)` pair, sorted by surface then model. */
export function surfaceModelPairs(reg: CapsRegistry): CapsPair[] {
  const pairs: CapsPair[] = [];
  for (const s of [...reg.surfaces].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const m of [...reg.models].sort((a, b) => a.id.localeCompare(b.id))) {
      const r = resolvePairIn(reg, s.id, m.id);
      if (r.ok) pairs.push(r.pair);
    }
  }
  return pairs;
}

/** Surfaces a host can run, sorted. */
export function hostedSurfaces(reg: CapsRegistry, hostId: string): string[] {
  return reg.hosting.filter((e) => e.host === hostId).map((e) => e.guest).sort();
}

/** Capabilities with any sensitivity flag set: callable only through their hard-limit gates. */
export function gatedCapabilities(reg: CapsRegistry): CapsRegistry['capabilities'] {
  return reg.capabilities.filter((c) => SENSITIVITY_FLAGS.some((f) => c.sensitivity[f]));
}
