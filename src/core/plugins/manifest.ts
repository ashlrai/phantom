/**
 * core/plugins/manifest.ts — M33 plugin manifest reader + validator.
 *
 * CONTRACT RULES (non-negotiable):
 *  - readManifest NEVER throws; all errors are returned as { ok: false; reason }.
 *  - Bounded read: manifests exceeding 64 KB are rejected.
 *  - Proto-pollution: any object key equal to "__proto__", "constructor", or
 *    "prototype" anywhere in the parsed object rejects the manifest.
 *  - name must match ^[a-z][a-z0-9-]{0,39}$ AND equal basename(dir).
 *  - entry must resolve INSIDE the plugin dir (path-string containment).
 *    The entry file itself may not exist at discovery time — only the path
 *    is validated, not its presence.
 *  - apiVersion is evaluated against PLUGIN_API_VERSION with a hand-rolled
 *    range matcher (exact, ^, ~, x-wildcards). No runtime deps.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, basename, sep, resolve } from 'node:path';
import {
  PLUGIN_API_VERSION,
  isPluginCapability,
  isPluginRecord,
  isValidPluginName,
  type PluginManifest,
  type PluginCapability,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed manifest.json size in bytes (64 KB). */
const MAX_MANIFEST_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Proto-pollution guard
// ---------------------------------------------------------------------------

/**
 * Recursively scan a parsed JSON value for __proto__, constructor, or
 * prototype keys. Returns true if any such key is found (poison detected).
 * Bounded: objects/arrays in a manifest.json are small; no stack overflow risk
 * in practice, but we cap depth at 8 to be defensive.
 */
function hasPoisonKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasPoisonKey(item, depth + 1));
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return true;
    }
    if (hasPoisonKey(record[key], depth + 1)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Hand-rolled semver range matcher
// ---------------------------------------------------------------------------

function parseNonNegInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Parse a semver string "MAJOR.MINOR.PATCH" into a numeric triple.
 * Returns null if the string is not parseable as a 3-part semver.
 */
function parseSemver(s: string): [number, number, number] | null {
  const parts = s.trim().split('.');
  if (parts.length !== 3) return null;
  const maj = parseNonNegInt(parts[0]);
  const min = parseNonNegInt(parts[1]);
  const patch = parseNonNegInt(parts[2]);
  return maj !== null && min !== null && patch !== null ? [maj, min, patch] : null;
}

/**
 * Evaluate whether `host` (the host's PLUGIN_API_VERSION) satisfies the
 * plugin's `range` declaration.
 *
 * Supported range forms:
 *  - exact:    "1.0.0"   → host must be exactly 1.0.0
 *  - caret:    "^1.0.0"  → host major must match, host >= range version
 *  - tilde:    "~1.0.0"  → host major+minor must match, host >= range version
 *  - wildcard: "1.x"     → host major must match; minor/patch free
 *              "1.0.x"   → host major+minor must match; patch free
 *
 * Returns true iff host satisfies the range.
 * Returns false for any unrecognised range form (strict unknown rejection).
 */
function semverSatisfies(range: string, host: string): boolean {
  const hostParsed = parseSemver(host);
  if (!hostParsed) return false;
  const [hMaj, hMin, hPatch] = hostParsed;

  const r = range.trim();

  // Caret (^MAJOR.MINOR.PATCH) or tilde (~MAJOR.MINOR.PATCH)
  if (r.startsWith('^') || r.startsWith('~')) {
    const parsed = parseSemver(r.slice(1));
    if (!parsed) return false;
    const [rMaj, rMin, rPatch] = parsed;
    if (hMaj !== rMaj) return false;
    if (r.startsWith('~')) return hMin === rMin && hPatch >= rPatch;
    return hMin > rMin || (hMin === rMin && hPatch >= rPatch);
  }

  // Wildcard: "1.x" or "1.0.x"
  if (r.includes('x') || r.includes('X') || r.includes('*')) {
    const parts = r.split('.');
    if (parts.length !== 2 && parts.length !== 3) return false;
    const last = (parts[parts.length - 1] ?? '').trim().toLowerCase();
    if (last !== 'x' && last !== '*') return false;
    const maj = parseNonNegInt(parts[0]);
    if (maj === null || hMaj !== maj) return false;
    if (parts.length === 2) return true;
    const min = parseNonNegInt(parts[1]);
    return min !== null && hMin === min;
  }

  // Exact: "MAJOR.MINOR.PATCH"
  const parsed = parseSemver(r);
  if (!parsed) return false;
  const [rMaj, rMin, rPatch] = parsed;
  return hMaj === rMaj && hMin === rMin && hPatch === rPatch;
}

function readRequiredString(
  obj: Record<string, unknown>,
  field: 'name' | 'version' | 'apiVersion' | 'entry',
  dir: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const raw = obj[field];
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: `manifest.json: "${field}" must be a non-empty string in ${dir}` };
  }
  return { ok: true, value: raw };
}

// ---------------------------------------------------------------------------
// readManifest — public API
// ---------------------------------------------------------------------------

/**
 * Read and fully validate <dir>/manifest.json.
 *
 * Returns { ok: true; manifest } on success.
 * Returns { ok: false; reason } on any validation failure.
 *
 * NEVER throws — all errors are caught and returned as { ok: false }.
 */
export function readManifest(
  dir: string,
): { ok: true; manifest: PluginManifest } | { ok: false; reason: string } {
  try {
    const manifestPath = join(dir, 'manifest.json');

    // --- Bounded read (≤ 64 KB) ---
    let size: number;
    try {
      const stat = statSync(manifestPath);
      size = stat.size;
    } catch {
      return { ok: false, reason: `manifest.json not found or unreadable in ${dir}` };
    }

    if (size > MAX_MANIFEST_BYTES) {
      return {
        ok: false,
        reason: `manifest.json exceeds 64 KB limit (${size} bytes) in ${dir}`,
      };
    }

    // --- Read + parse ---
    let raw: string;
    try {
      raw = readFileSync(manifestPath, 'utf8');
    } catch {
      return { ok: false, reason: `could not read manifest.json in ${dir}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: `manifest.json is not valid JSON in ${dir}` };
    }

    // --- Proto-pollution guard (before any property access) ---
    if (hasPoisonKey(parsed)) {
      return {
        ok: false,
        reason: `manifest.json contains forbidden key (__proto__/constructor/prototype) in ${dir}`,
      };
    }

    // --- Top-level must be a plain object ---
    if (!isPluginRecord(parsed)) {
      return { ok: false, reason: `manifest.json must be a plain object in ${dir}` };
    }

    // --- Required string fields ---
    const nameField = readRequiredString(parsed, 'name', dir);
    if (!nameField.ok) return nameField;
    const versionField = readRequiredString(parsed, 'version', dir);
    if (!versionField.ok) return versionField;
    const apiVersionField = readRequiredString(parsed, 'apiVersion', dir);
    if (!apiVersionField.ok) return apiVersionField;
    const entryField = readRequiredString(parsed, 'entry', dir);
    if (!entryField.ok) return entryField;

    const name = nameField.value;
    const version = versionField.value;
    const apiVersion = apiVersionField.value;
    const entry = entryField.value;

    // --- name pattern ---
    if (!isValidPluginName(name)) {
      return {
        ok: false,
        reason: `manifest.json: name "${name}" does not match ^[a-z][a-z0-9-]{0,39}$ in ${dir}`,
      };
    }

    // --- name === basename(dir) ---
    const dirBase = basename(resolve(dir));
    if (name !== dirBase) {
      return {
        ok: false,
        reason: `manifest.json: name "${name}" must equal directory basename "${dirBase}" in ${dir}`,
      };
    }

    // --- apiVersion semver range compatibility ---
    if (!semverSatisfies(apiVersion, PLUGIN_API_VERSION)) {
      return {
        ok: false,
        reason: `manifest.json: apiVersion range "${apiVersion}" is not satisfied by host version ${PLUGIN_API_VERSION} in ${dir}`,
      };
    }

    // --- capabilities: non-empty array of valid strings ---
    if (!Array.isArray(parsed['capabilities']) || (parsed['capabilities'] as unknown[]).length === 0) {
      return {
        ok: false,
        reason: `manifest.json: "capabilities" must be a non-empty array in ${dir}`,
      };
    }
    const rawCapabilities = parsed['capabilities'] as unknown[];
    const capabilities: PluginCapability[] = [];
    for (const cap of rawCapabilities) {
      if (!isPluginCapability(cap)) {
        return {
          ok: false,
          reason: `manifest.json: invalid capability "${String(cap)}" in ${dir}`,
        };
      }
      capabilities.push(cap);
    }

    // --- entry: relative, no absolute, no ".." traversal ---
    // Entry must not be absolute.
    if (entry.startsWith('/')) {
      return {
        ok: false,
        reason: `manifest.json: entry "${entry}" must be a relative path in ${dir}`,
      };
    }

    // Resolve entry inside dir and verify containment (path-string check).
    const resolvedDir = resolve(dir) + sep;
    const resolvedEntry = resolve(dir, entry);

    // Containment: resolvedEntry must start with resolvedDir (with trailing sep
    // to prevent "prefix" attacks like /plugins/foo-extra matching /plugins/foo/).
    if (!resolvedEntry.startsWith(resolvedDir)) {
      return {
        ok: false,
        reason: `manifest.json: entry "${entry}" resolves outside plugin directory in ${dir}`,
      };
    }

    // --- Optional fields ---
    const description =
      typeof parsed['description'] === 'string' ? parsed['description'] : undefined;
    const homepage =
      typeof parsed['homepage'] === 'string' ? parsed['homepage'] : undefined;

    const manifest: PluginManifest = {
      name,
      version,
      apiVersion,
      entry,
      capabilities,
      ...(description !== undefined ? { description } : {}),
      ...(homepage !== undefined ? { homepage } : {}),
    };

    return { ok: true, manifest };
  } catch {
    // Belt-and-suspenders: readManifest must never throw.
    return { ok: false, reason: `unexpected error reading manifest in ${dir}` };
  }
}
