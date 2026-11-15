/**
 * reader.ts: the browser fallback of RQ-USAGE-LIVE-1. Drives nothing itself:
 * the caller injects `fetchVisibleText` (a headed browser on the persistent
 * profile) and this module parses the visible text and writes one JSON record
 * per provider to the bus. It never reads cookies, tokens, the keychain,
 * browser databases or any ~/.codex* path; the profile directory is only
 * handed to the injected driver as an opaque path.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BROWSER_PROVIDERS, parseUsagePage, type BrowserProvider, type BrowserUsageRecord, type ParseRefusal } from './parsers.js';

/** Default pages. Configurable: provider UIs move, the parsers do not follow URLs. */
export const BROWSER_USAGE_URLS: Record<BrowserProvider, string> = {
  claude: 'https://claude.ai/settings/usage',
  chatgpt: 'https://chatgpt.com/codex/settings/usage',
  devin: 'https://app.devin.ai/settings/billing',
  zai: 'https://z.ai/manage-apikey/subscription',
  gemini: 'https://gemini.google.com/app',
};

export interface BrowserUsageDeps {
  /** Visible text of `url`, rendered in the persistent profile at `profileDir`. */
  fetchVisibleText: (req: { provider: BrowserProvider; url: string; profileDir: string }) => Promise<string>;
  now?: () => Date;
  homeDir?: string;
  /** Persistent profile; default ~/.ashlr-runs/usage-browser. */
  profileDir?: string;
  urls?: Partial<Record<BrowserProvider, string>>;
}

export type BrowserUsageResult =
  | { ok: true; provider: BrowserProvider; record: BrowserUsageRecord }
  | { ok: false; provider: BrowserProvider; reason: ParseRefusal | 'fetch-failed' };

export const defaultProfileDir = (home = homedir()): string => join(home, '.ashlr-runs', 'usage-browser');

export async function readBrowserUsage(provider: BrowserProvider, deps: BrowserUsageDeps): Promise<BrowserUsageResult> {
  const profileDir = deps.profileDir ?? defaultProfileDir(deps.homeDir);
  const url = deps.urls?.[provider] ?? BROWSER_USAGE_URLS[provider];
  let text: string;
  try {
    text = await deps.fetchVisibleText({ provider, url, profileDir });
  } catch {
    return { ok: false, provider, reason: 'fetch-failed' };
  }
  const parsed = parseUsagePage(provider, text, (deps.now ?? (() => new Date()))());
  return parsed.ok ? { ok: true, provider, record: parsed.record } : { ok: false, provider, reason: parsed.reason };
}

/** Read every provider sequentially (one visible browser at a time). */
export async function readAllBrowserUsage(deps: BrowserUsageDeps, providers: readonly BrowserProvider[] = BROWSER_PROVIDERS): Promise<BrowserUsageResult[]> {
  const results: BrowserUsageResult[] = [];
  for (const provider of providers) results.push(await readBrowserUsage(provider, deps));
  return results;
}

/** Write `<busDir>/usage-browser-<provider>.json` atomically; refusals write nothing. */
export async function writeBusRecords(results: readonly BrowserUsageResult[], busDir: string): Promise<string[]> {
  await mkdir(busDir, { recursive: true });
  const written: string[] = [];
  for (const r of results) {
    if (!r.ok) continue;
    const path = join(busDir, `usage-browser-${r.provider}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(r.record, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
    written.push(path);
  }
  return written;
}
