import { InstallError } from './storage.js';
/** Declarative install metadata. Commands, scripts and credential values are not part of this format. */
import { z } from 'zod';
import { assertMetadata } from '../connectors/profile.js';
import { hasSecretLikeArgv } from '../mcp-argv-safety.js';

export const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const identifier = z.string().max(64).regex(/^[a-z][a-z0-9-]*$/).refine(value => !reserved.has(value));
const binary = z.string().max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).refine(value => !reserved.has(value));
const vaultName = z.string().max(80).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/).refine(value => !reserved.has(value));

export function safeRelativeFile(value: string): boolean {
  return value.length <= 256 && /^[A-Za-z0-9_./-]+$/.test(value) &&
    !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export const installManifestSchema = z.object({
  version: z.literal(1),
  id: identifier,
  install: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('npm'), package: z.string().max(214).regex(NPM_NAME), version: z.string().max(128).regex(EXACT_VERSION), bin: binary }).strict(),
    z.object({ kind: z.literal('git'), repo: z.string().regex(REPO_NAME), commit: z.string().regex(/^[a-f0-9]{40}$/),
      bin: z.string().refine(value => safeRelativeFile(value) && /\.(?:js|cjs|mjs)$/.test(value)) }).strict(),
  ]),
  mcp: z.object({ args: z.array(z.string().max(512).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127))).max(32).default([]) }).strict().optional(),
  secrets: z.array(z.object({ env: z.string().max(80).regex(/^[A-Z][A-Z0-9_]*$/), name: vaultName }).strict()).max(32).default([]),
}).strict().superRefine((manifest, ctx) => {
  if (new Set(manifest.secrets.map(secret => secret.env)).size !== manifest.secrets.length) ctx.addIssue({ code: 'custom', message: 'Duplicate secret binding.' });
  if (hasSecretLikeArgv(manifest.mcp?.args ?? [])) ctx.addIssue({ code: 'custom', message: 'Credential arguments are not supported.' });
});
export type InstallManifest = z.infer<typeof installManifestSchema>;

export function parseInstallManifest(value: unknown): InstallManifest {
  // Reject before validation; schema diagnostics must never echo rejected data.
  try { assertMetadata(JSON.stringify(value)); } catch { throw new InstallError('Install metadata contains secret-shaped values; use vault names only.'); }
  const parsed = installManifestSchema.safeParse(value);
  if (!parsed.success) throw new InstallError('Invalid install manifest. Use version 1 and documented declarative fields.');
  return parsed.data;
}
