/**
 * Adapter generator: capability registry -> per-agent config artifacts.
 *
 * Pure, deterministic codegen. The same registry always yields byte-identical
 * artifacts, so every artifact has a stable sha256 and the bundle as a whole
 * has one too. Generated adapters are PINNED ARTIFACTS: the manifest records
 * each sha plus the pin-stage hand-off (SEC-PIN-STAGE-TOOL-2, `pin_stage_lib`
 * fe77a6a8). This module never invokes that tool and never edits Security's
 * pinned bin/ files; it only stages a directory the tool can verify with the
 * emitted `SHA256SUMS`.
 *
 * Secret hygiene: adapters reference credentials by NAME using each host's
 * own variable-expansion syntax (`${NAME}`, `env_vars = ["NAME"]`, …). No
 * value is read, resolved or written; the final bundle is re-screened.
 *
 * Hard-limit gating: capabilities flagged external_send / spend / delete are
 * never loaded directly by an adapter. They appear only in the manifest's
 * `gated` list (with their gate ids) and, for Claude Code, as explicit denies,
 * so the existing hard-limit gates stay the only path to them.
 */

import { createHash } from 'node:crypto';
import { stringify as tomlStringify } from 'smol-toml';
import { assertMetadata } from '../connectors/profile.js';
import { gatedCapabilities, hostedSurfaces } from './registry.js';
import { CAPS_SCHEMA_ID, type AdapterFormat, type Capability, type CapsRegistry, type CapsSession, type CapsSurface } from './schema.js';

export const CAPS_ADAPTERS_SCHEMA_ID = 'caps.adapters.v1';

/** Security's pin-stage tool; the hand-off is documented in docs/CAPABILITY-REGISTRY.md. */
export const PIN_STAGE = Object.freeze({
  tool: 'SEC-PIN-STAGE-TOOL-2',
  lib: 'pin_stage_lib',
  libRev: 'fe77a6a8',
  /** `~`-relative on purpose: the manifest never embeds a real home path. */
  stagedRoot: '~/.ashlr-runs/staged/caps',
});

export interface CapsArtifact {
  /** POSIX path relative to the output directory. */
  path: string;
  surface: string | null;
  format: AdapterFormat | 'session' | 'checksums';
  content: string;
  sha256: string;
}

export interface CapsBundle {
  registrySha256: string;
  bundleSha256: string;
  /** Adapter artifacts plus `SHA256SUMS`; `manifest.json` is separate. */
  artifacts: CapsArtifact[];
  manifest: CapsManifest;
  manifestContent: string;
}

export interface CapsManifest {
  schema: typeof CAPS_ADAPTERS_SCHEMA_ID;
  registrySchema: typeof CAPS_SCHEMA_ID;
  generator: 'phm caps generate';
  registrySha256: string;
  bundleSha256: string;
  artifacts: Array<{ path: string; surface: string | null; format: CapsArtifact['format']; sha256: string; bytes: number }>;
  pinStage: typeof PIN_STAGE & { stagedDir: string };
  gated: Array<{ capability: string; surfaces: string[]; flags: string[]; hardLimitGates: string[] }>;
  surfaces: Record<string, { adapter: AdapterFormat; capabilities: Record<string, string[]>; hosts: string[] }>;
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Deterministic pretty JSON: object keys sorted, two-space indent, trailing newline. */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id);

// ---------------------------------------------------------------------------
// Per-format MCP server rendering
// ---------------------------------------------------------------------------

type EnvSyntax = (name: string) => string;
const ENV_SYNTAX: Record<'claude' | 'vscode' | 'gemini', EnvSyntax> = {
  claude: (n) => `\${${n}}`,
  vscode: (n) => `\${env:${n}}`,
  gemini: (n) => `$${n}`,
};

function isGated(c: Capability): boolean {
  return c.sensitivity.external_send || c.sensitivity.spend || c.sensitivity.delete;
}

/** Ungated MCP capabilities a surface may load directly, sorted by id. */
function directMcp(reg: CapsRegistry, surfaceId: string, only?: readonly string[]): Capability[] {
  return reg.capabilities
    .filter((c) => c.kind === 'mcp' && c.launch && !isGated(c) && c.surfaces.includes(surfaceId) && (!only || only.includes(c.id)))
    .sort(byId);
}

function envNames(c: Capability): string[] {
  return (c.launch?.env ?? []).map((e) => e.name).sort();
}

function mcpServers(caps: readonly Capability[], env: EnvSyntax, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(caps.map((c) => {
    const names = envNames(c);
    return [c.id, {
      ...extra,
      command: c.launch!.command,
      args: c.launch!.args,
      ...(names.length ? { env: Object.fromEntries(names.map((n) => [n, env(n)])) } : {}),
    }];
  }));
}

function codexToml(caps: readonly Capability[]): string {
  const servers = Object.fromEntries(caps.map((c) => {
    const names = envNames(c);
    // Codex forwards named variables from the parent environment; no values.
    return [c.id, { command: c.launch!.command, args: c.launch!.args, ...(names.length ? { env_vars: names } : {}) }];
  }));
  return `# Generated by phm caps generate from capabilities/registry.v1.json. Do not edit.\n${tomlStringify({ mcp_servers: servers })}\n`;
}

function modelsFor(reg: CapsRegistry, lane: string): string[] {
  return reg.models.filter((m) => m.lane === lane).map((m) => m.providerModelId).sort();
}

/**
 * Claude Code permission denies for gated capabilities on a surface: the MCP
 * server's tools, or the CLI invocation prefix. Connectors driven through a
 * control backend have no Claude Code tool name; the manifest's `gated` list
 * covers them.
 */
function gatedDenies(reg: CapsRegistry, surfaceId: string): string[] {
  return gatedCapabilities(reg).filter((c) => c.surfaces.includes(surfaceId)).flatMap((c) => {
    if (c.kind === 'mcp') return [`mcp__${c.id}`];
    if (c.kind === 'cli' && c.launch) return [`Bash(${[c.launch.command, ...c.launch.args].join(' ')}:*)`];
    return [];
  }).sort();
}

interface Draft { path: string; surface: string | null; format: CapsArtifact['format']; content: string }

function surfaceArtifacts(reg: CapsRegistry, s: CapsSurface): Draft[] {
  const at = (ext: string): string => `${s.adapter}/${s.id}.${ext}`;
  const caps = directMcp(reg, s.id);
  const draft = (path: string, content: string): Draft => ({ path, surface: s.id, format: s.adapter, content });
  switch (s.adapter) {
    case 'claude-code':
      return [
        draft(at('mcp.json'), stableJson({ mcpServers: mcpServers(caps, ENV_SYNTAX.claude) })),
        draft(at('settings.json'), stableJson({ permissions: { deny: gatedDenies(reg, s.id) } })),
      ];
    case 'codex':
      return [draft(at('config.toml'), codexToml(caps))];
    case 'cursor':
      return [draft(at('mcp.json'), stableJson({ mcpServers: mcpServers(caps, ENV_SYNTAX.vscode) }))];
    case 'gemini':
      return [draft(at('settings.json'), stableJson({ mcpServers: mcpServers(caps, ENV_SYNTAX.gemini) }))];
    case 'copilot':
      return [draft(at('mcp.json'), stableJson({ servers: mcpServers(caps, ENV_SYNTAX.vscode, { type: 'stdio' }) }))];
    case 'grok-build':
      return [draft(at('json'), stableJson({ mcpServers: mcpServers(caps, ENV_SYNTAX.claude), models: modelsFor(reg, s.lane) }))];
    case 'devin': {
      // Devin is a hub: its adapter carries one sub-config per hosted surface,
      // each with only the capabilities enabled on that guest.
      const hosted = hostedSurfaces(reg, s.id).map((guestId) => {
        const guest = reg.surfaces.find((g) => g.id === guestId)!;
        const edge = reg.hosting.find((e) => e.host === s.id && e.guest === guestId)!;
        return {
          surface: guest.id,
          via: edge.via,
          lane: guest.lane,
          models: modelsFor(reg, guest.lane),
          mcpServers: mcpServers(directMcp(reg, guest.id), ENV_SYNTAX.claude),
        };
      });
      return [draft(at('json'), stableJson({ mcpServers: mcpServers(caps, ENV_SYNTAX.claude), models: modelsFor(reg, s.lane), hosted }))];
    }
    case 'local-model': {
      const net = s.network!;
      const allowlist = reg.egressAllowlists.find((e) => e.id === net.egressAllowlistRef)!;
      return [draft(at('json'), stableJson({
        bind: net.bind,
        keyForwarding: net.keyForwarding,
        egress: { allowlistRef: allowlist.id, hosts: [...allowlist.hosts].sort() },
        models: modelsFor(reg, s.lane),
        mcpServers: mcpServers(caps, ENV_SYNTAX.claude),
      }))];
    }
    case 'none':
      return [];
  }
}

/** A pinned-model session (e.g. the Weyv lead on Fable 5.2) is a Claude Code profile, not an agent. */
function sessionArtifacts(reg: CapsRegistry, session: CapsSession): Draft[] {
  const surface = reg.surfaces.find((s) => s.id === session.surface)!;
  const model = reg.models.find((m) => m.id === session.model)!;
  const caps = directMcp(reg, surface.id, session.capabilities);
  const base = `sessions/${session.id}`;
  const draft = (path: string, content: string): Draft => ({ path, surface: surface.id, format: 'session', content });
  if (surface.adapter === 'claude-code') {
    return [
      draft(`${base}.settings.json`, stableJson({ model: model.providerModelId, permissions: { deny: gatedDenies(reg, surface.id) } })),
      draft(`${base}.mcp.json`, stableJson({ mcpServers: mcpServers(caps, ENV_SYNTAX.claude) })),
    ];
  }
  return [draft(`${base}.json`, stableJson({ surface: surface.id, model: model.providerModelId, role: session.role, mcpServers: mcpServers(caps, ENV_SYNTAX.claude) }))];
}

function capabilityIndex(reg: CapsRegistry, surfaceId: string): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const c of [...reg.capabilities].sort(byId)) {
    if (!c.surfaces.includes(surfaceId)) continue;
    (index[c.kind] ??= []).push(c.id);
  }
  return index;
}

/** Generate the adapter bundle. Pure; throws if any output looks secret-shaped. */
export function generateCapsAdapters(reg: CapsRegistry): CapsBundle {
  const registrySha256 = sha256(stableJson(reg));
  const drafts = [
    ...[...reg.surfaces].sort(byId).flatMap((s) => surfaceArtifacts(reg, s)),
    ...[...reg.sessions].sort(byId).flatMap((s) => sessionArtifacts(reg, s)),
  ].sort((a, b) => a.path.localeCompare(b.path));
  const adapters: CapsArtifact[] = drafts.map((d) => ({ ...d, sha256: sha256(d.content) }));
  // sha256sum/shasum -c format, which the pin-stage tool can verify directly.
  const sums = adapters.map((a) => `${a.sha256}  ${a.path}\n`).join('');
  const bundleSha256 = sha256(sums);
  const artifacts: CapsArtifact[] = [...adapters, { path: 'SHA256SUMS', surface: null, format: 'checksums', content: sums, sha256: sha256(sums) }];

  const manifest: CapsManifest = {
    schema: CAPS_ADAPTERS_SCHEMA_ID,
    registrySchema: CAPS_SCHEMA_ID,
    generator: 'phm caps generate',
    registrySha256,
    bundleSha256,
    artifacts: artifacts.map((a) => ({ path: a.path, surface: a.surface, format: a.format, sha256: a.sha256, bytes: Buffer.byteLength(a.content) })),
    pinStage: { ...PIN_STAGE, stagedDir: `${PIN_STAGE.stagedRoot}/${bundleSha256}` },
    gated: gatedCapabilities(reg).sort(byId).map((c) => ({
      capability: c.id,
      surfaces: [...c.surfaces].sort(),
      flags: (['external_send', 'spend', 'delete'] as const).filter((f) => c.sensitivity[f]),
      hardLimitGates: [...c.hardLimitGates].sort(),
    })),
    surfaces: Object.fromEntries([...reg.surfaces].sort(byId).map((s) => [s.id, {
      adapter: s.adapter,
      capabilities: capabilityIndex(reg, s.id),
      hosts: reg.hosting.filter((e) => e.guest === s.id).map((e) => e.host).sort(),
    }])),
  };
  const manifestContent = stableJson(manifest);
  // Defense in depth: the registry was screened, but re-screen what we emit.
  // Our own sha256 digests are high-entropy hex the scrubber would flag, so
  // they are masked first; nothing else is.
  const ours = new Set([registrySha256, bundleSha256, ...artifacts.map((a) => a.sha256)]);
  const mask = (text: string): string => text.replace(/\b[0-9a-f]{64}\b/g, (hex) => ours.has(hex) ? 'sha256' : hex);
  for (const text of [...artifacts.map((a) => a.content), manifestContent]) assertMetadata(mask(text));
  return { registrySha256, bundleSha256, artifacts, manifest, manifestContent };
}
