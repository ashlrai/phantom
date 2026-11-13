/**
 * Dedicated usage browser. One persistent profile under ~/.ashlr-runs/usage-browser/,
 * used only to open the provider usage pages and read their visible text.
 *
 * Boundaries, enforced by the narrow interface below: the driver can navigate,
 * report the current URL and return the rendered body text. It has no cookie,
 * storage-state, token, keychain or file access, and the profile path may not be
 * a Codex home. Sign-in is done by the operator in this browser, the normal way.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { bindingWindow, needsSignin, parseVisibleWindows, type UsageSite } from './sites.js';

export interface BrowserPage {
  goto(url: string, timeoutMs: number): Promise<void>;
  url(): string;
  /** Rendered text of the page body, as a person would see it. */
  visibleText(): Promise<string>;
  close(): Promise<void>;
}
export interface BrowserSession { newPage(): Promise<BrowserPage>; close(): Promise<void> }
export type BrowserLauncher = (profileDir: string, options: { headless: boolean }) => Promise<BrowserSession>;

export function usageBrowserDir(home = homedir()): string { return join(home, '.ashlr-runs', 'usage-browser'); }

/** The profile must be the usage browser dir (or a child), never a Codex home or other app profile. */
export function profileDirAllowed(dir: string, home = homedir()): boolean {
  if (!isAbsolute(dir) || /[\0\r\n]/.test(dir)) return false;
  const norm = resolve(dir);
  if (/(?:^|\/)\.codex[^/]*(?:\/|$)/.test(norm)) return false;
  const root = usageBrowserDir(home);
  return norm === root || norm.startsWith(`${root}/`);
}

export type SiteReading =
  | { status: 'ok'; site: UsageSite['id']; used: number; limit: number; unit: 'percent' | 'acu'; resetAt: string | null; observedAt: string }
  | { status: 'needs-signin'; site: UsageSite['id']; label: string; url: string }
  | { status: 'unreadable'; site: UsageSite['id']; reason: 'navigation-failed' | 'no-visible-numbers' };

/** Read one usage page. Never throws: a failure is `unreadable`, never zero. */
export async function readSite(site: UsageSite, session: BrowserSession, nowMs: number, timeoutMs = 30_000): Promise<SiteReading> {
  let page: BrowserPage | null = null;
  try {
    page = await session.newPage();
    await page.goto(site.url, timeoutMs);
    const text = await page.visibleText();
    const finalUrl = page.url();
    const windows = parseVisibleWindows(site.unit, text, nowMs);
    if (needsSignin(site, finalUrl, text, windows)) {
      return { status: 'needs-signin', site: site.id, label: site.label, url: site.url };
    }
    const win = bindingWindow(windows);
    if (!win) return { status: 'unreadable', site: site.id, reason: 'no-visible-numbers' };
    return { status: 'ok', site: site.id, used: win.used, limit: win.limit, unit: site.unit,
      resetAt: win.resetAt, observedAt: new Date(nowMs).toISOString() };
  } catch {
    return { status: 'unreadable', site: site.id, reason: 'navigation-failed' };
  } finally {
    try { await page?.close(); } catch { /* best effort */ }
  }
}

/** Optional Playwright driver. Playwright is not a Phantom dependency; absent means no browser pass. */
export const playwrightLauncher: BrowserLauncher = async (profileDir, options) => {
  if (!profileDirAllowed(profileDir)) throw new Error('Usage browser profile path refused');
  const name = 'playwright';
  const pw = await import(name) as { chromium: { launchPersistentContext(dir: string, o: object): Promise<{
    newPage(): Promise<{ goto(u: string, o: object): Promise<unknown>; url(): string; innerText(s: string): Promise<string>; close(): Promise<void> }>;
    close(): Promise<void> }> } };
  const context = await pw.chromium.launchPersistentContext(profileDir, { headless: options.headless });
  return {
    async newPage() {
      const page = await context.newPage();
      return {
        goto: async (url, timeoutMs) => { await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs }); },
        url: () => page.url(),
        visibleText: () => page.innerText('body'),
        close: () => page.close(),
      };
    },
    close: () => context.close(),
  };
};
