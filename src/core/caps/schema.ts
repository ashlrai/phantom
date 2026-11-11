/**
 * Capability registry schema (PHANTOM-OS-1, `caps.registry.v1`).
 *
 * One in-repo, versioned source of truth for MCPs, skills, plugins, CLIs,
 * connectors and ACCOUNT REFERENCES, plus the surfaces and models the router
 * pairs them with. Data only: nothing here starts a process, resolves a
 * credential, contacts a provider or grants authority.
 *
 * Shape decisions (each is enforced by `validateCapsRegistry`, not by comment):
 *
 * - SURFACES and MODELS are distinct record types. A surface is where an agent
 *   runs (Claude Code, Codex CLI, Devin Desktop, local oMLX). A model is what
 *   it thinks with. The router chooses a `(surface, model)` pair; a pair is
 *   valid only when both share a lane. Fable 5.2 is therefore a Claude-lane
 *   MODEL beside Opus and Sonnet — never a surface, agent or app.
 * - Models name an existing router catalog id (`run/model-catalog.ts`) when
 *   the router knows them, and surfaces name an existing engine id
 *   (`run/engine-registry.ts`). The registry never redefines either.
 * - Hosted-agent relationships (Devin hosting Gemini, Cursor, Codex, …) are
 *   first-class `hosting` edges, not flags on a surface.
 * - Accounts carry a credential NAME and scopes only. Objects are closed
 *   (`.strict()`), so a value/token field cannot be added, and the whole
 *   document is screened for secret-shaped text before parsing.
 * - Capabilities declare `external_send`, `spend` and `delete` explicitly.
 *   Effects that imply a flag must set it, and any set flag requires the
 *   matching constitutional hard-limit gate id.
 * - Control backends are an allowlist. TCC database, app database, screen
 *   scraping and out-of-band TCC grants are refused by name.
 * - Local model surfaces bind 127.0.0.1, never forward keys, and reference an
 *   egress allowlist by id (never "open").
 * - Auto-file metadata fields come from a closed enum with no field able to
 *   hold screen contents or secret values.
 */

import { z } from 'zod';
import type { HardLimit } from '../fleet/needs-mason-triage.js';

export const CAPS_SCHEMA_ID = 'caps.registry.v1';
export const CAPS_SCHEMA_VERSION = 1;

/** Lower-kebab ids, the same alphabet `phm` uses for job and lane names. */
export const capsId = z.string().regex(/^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/).max(80);
const text = z.string().min(1).max(500);
const ids = z.array(capsId).max(128);

// ---------------------------------------------------------------------------
// Control backends (security requirement a)
// ---------------------------------------------------------------------------

/** How a capability drives a desktop app. Every member is a supported, user-visible channel. */
export const CONTROL_BACKENDS = [
  'ax', 'applescript', 'jxa', 'shortcuts', 'app-cli', 'url-scheme', 'cdp-loopback', 'playwright-loopback',
] as const;
export type ControlBackend = (typeof CONTROL_BACKENDS)[number];

/**
 * Refused by name, with a specific reason, so a contributor who reaches for
 * one learns why instead of seeing a bare enum error.
 */
export const FORBIDDEN_CONTROL_BACKENDS: Readonly<Record<string, string>> = Object.freeze({
  'tcc-db': 'reads or writes the TCC privacy database',
  'tcc-grant': 'grants TCC permission out of band',
  'app-db': 'reads an application database directly',
  scrape: 'scrapes screen or app contents',
  'screen-scrape': 'scrapes screen or app contents',
});

const browserBackends = new Set<ControlBackend>(['cdp-loopback', 'playwright-loopback']);

const control = z.object({
  backend: z.string().max(40),
  /** Required for CDP/Playwright: a fresh profile per run, on loopback only. */
  profile: z.literal('per-run').optional(),
  bind: z.literal('127.0.0.1').optional(),
}).strict();

// ---------------------------------------------------------------------------
// Sensitivity (security requirement d)
// ---------------------------------------------------------------------------

export const SENSITIVITY_FLAGS = ['external_send', 'spend', 'delete'] as const;
export type SensitivityFlag = (typeof SENSITIVITY_FLAGS)[number];

/**
 * The constitution's hard limits (CONSTITUTION.md; ids from
 * fleet/needs-mason-triage.ts `HardLimit`). A flagged capability is callable
 * only through the gate that already guards that limit.
 */
export const HARD_LIMIT_GATES = ['outside-send', 'money', 'destroy-data', 'secrets'] as const satisfies readonly HardLimit[];
export type HardLimitGate = (typeof HARD_LIMIT_GATES)[number];
export const HARD_LIMIT_GATE_FOR: Readonly<Record<SensitivityFlag, HardLimitGate>> = Object.freeze({
  external_send: 'outside-send',
  spend: 'money',
  delete: 'destroy-data',
});

/** What a capability does. Some effects imply a sensitivity flag. */
export const EFFECTS = [
  'read', 'write-local', 'write-remote',
  'send-mail', 'send-message', 'post-slack', 'post-public',
  'spend', 'plan-change',
  'delete-data',
] as const;
export type Effect = (typeof EFFECTS)[number];

export const EFFECT_IMPLIES: Readonly<Partial<Record<Effect, SensitivityFlag>>> = Object.freeze({
  'send-mail': 'external_send',
  'send-message': 'external_send',
  'post-slack': 'external_send',
  'post-public': 'external_send',
  spend: 'spend',
  'plan-change': 'spend',
  'delete-data': 'delete',
});

const sensitivity = z.object({
  external_send: z.boolean(),
  spend: z.boolean(),
  delete: z.boolean(),
}).strict();

// ---------------------------------------------------------------------------
// Auto-file metadata (security requirement f)
// ---------------------------------------------------------------------------

/**
 * The only fields an auto-filed record may carry. Closed on purpose: there is
 * no member that can hold screen contents, clipboard, window text or a secret.
 */
export const AUTO_FILE_FIELDS = [
  'capability-id', 'surface-id', 'model-id', 'job-id', 'repo', 'timestamp', 'outcome', 'duration-ms', 'error-code',
] as const;

// ---------------------------------------------------------------------------
// Surfaces, models, hosting edges, sessions
// ---------------------------------------------------------------------------

export const SURFACE_KINDS = ['desktop', 'cli', 'cloud', 'bot', 'local-runtime'] as const;

/** Each value selects one adapter emitter in caps/generate.ts. */
export const ADAPTER_FORMATS = [
  'claude-code', 'codex', 'devin', 'cursor', 'grok-build', 'gemini', 'copilot', 'local-model', 'none',
] as const;
export type AdapterFormat = (typeof ADAPTER_FORMATS)[number];

const localNetwork = z.object({
  /** Loopback only (security requirement c). */
  bind: z.literal('127.0.0.1'),
  /** Provider keys are never forwarded to a local runtime. */
  keyForwarding: z.literal(false),
  /** Reference to a named egress allowlist; an open egress policy is not representable. */
  egressAllowlistRef: capsId,
}).strict();

const surface = z.object({
  id: capsId,
  name: text,
  kind: z.enum(SURFACE_KINDS),
  /** Router lane this surface spends from; models pair only within a lane. */
  lane: capsId,
  /** Existing engine id in run/engine-registry.ts, when the fleet drives it. */
  engine: capsId.optional(),
  adapter: z.enum(ADAPTER_FORMATS),
  /** True when the surface is only reachable through a hosting edge. */
  hostedOnly: z.boolean().default(false),
  network: localNetwork.optional(),
  description: text.optional(),
}).strict();

const model = z.object({
  id: capsId,
  name: text,
  lane: capsId,
  family: capsId,
  /** Existing router catalog id (`<engine>:<tag>`) in run/model-catalog.ts. Null = not routed by Phantom. */
  catalogId: z.string().regex(/^[a-z][a-z0-9-]*:[A-Za-z0-9._:/-]+$/).max(120).nullable(),
  /** Provider model id as the surface expects it (e.g. `claude-fable-5-2`). */
  providerModelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).max(120),
  /** Named allowance the model counts against (e.g. Max weekly Fable). Reference only. */
  allowance: capsId.optional(),
}).strict();

const hostingEdge = z.object({
  host: capsId,
  guest: capsId,
  /** How the host runs the guest (e.g. `devin-subagent`). */
  via: capsId,
}).strict();

const session = z.object({
  id: capsId,
  name: text,
  surface: capsId,
  model: capsId,
  role: capsId,
  capabilities: ids.default([]),
}).strict();

// ---------------------------------------------------------------------------
// Accounts (security requirement b) and capabilities
// ---------------------------------------------------------------------------

/** Vault NAME only (phantom-secrets / keychain item name). Never a value. */
export const credentialName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);

const account = z.object({
  id: capsId,
  provider: capsId,
  /** Where the named credential lives. The registry never reads it. */
  store: z.enum(['phantom-secrets', 'keychain', 'host-session']),
  credentialName: credentialName.nullable(),
  scopes: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/)).max(64),
}).strict();

export const CAPABILITY_KINDS = ['mcp', 'skill', 'plugin', 'cli', 'connector'] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

const launch = z.object({
  command: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).max(80),
  args: z.array(z.string().max(200)).max(32).default([]),
  /**
   * Environment variables the host fills from a named account. A list of
   * `{ name, account }` rather than a NAME -> id map: a map reads like a
   * credential assignment, which the secret screen rightly refuses.
   */
  env: z.array(z.object({ name: credentialName, account: capsId }).strict()).max(16).default([]),
}).strict();

const capability = z.object({
  id: capsId,
  kind: z.enum(CAPABILITY_KINDS),
  description: text,
  /** Surfaces that may load this capability. */
  surfaces: ids.min(1),
  accounts: ids.default([]),
  effects: z.array(z.enum(EFFECTS)).min(1).max(EFFECTS.length),
  sensitivity,
  /** Required when any sensitivity flag is set; must include the flag's gate. */
  hardLimitGates: z.array(z.enum(HARD_LIMIT_GATES)).max(HARD_LIMIT_GATES.length).default([]),
  control: control.optional(),
  launch: launch.optional(),
  autoFile: z.object({ fields: z.array(z.enum(AUTO_FILE_FIELDS)).min(1).max(AUTO_FILE_FIELDS.length) }).strict().optional(),
}).strict();

export const capsRegistrySchema = z.object({
  schema: z.literal(CAPS_SCHEMA_ID),
  version: z.literal(CAPS_SCHEMA_VERSION),
  surfaces: z.array(surface).min(1).max(128),
  models: z.array(model).max(256),
  hosting: z.array(hostingEdge).max(256),
  sessions: z.array(session).max(64).default([]),
  accounts: z.array(account).max(128),
  egressAllowlists: z.array(z.object({ id: capsId, hosts: z.array(z.string().regex(/^[a-z0-9.-]+(?::\d{1,5})?$/)).max(64) }).strict()).max(32).default([]),
  capabilities: z.array(capability).max(512),
}).strict();

export type CapsRegistry = z.infer<typeof capsRegistrySchema>;
export type CapsSurface = CapsRegistry['surfaces'][number];
export type CapsModel = CapsRegistry['models'][number];
export type CapsHostingEdge = CapsRegistry['hosting'][number];
export type CapsSession = CapsRegistry['sessions'][number];
export type CapsAccount = CapsRegistry['accounts'][number];
export type Capability = CapsRegistry['capabilities'][number];

export { browserBackends as BROWSER_CONTROL_BACKENDS };
