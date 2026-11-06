import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';

export interface GrokUsageReading {
  pool: 'grok-ultra';
  pctUsed: number | null;
  resetAt: string | null;
  source: 'grok-reader';
  fetchedAt: string;
}

/** Pin only after comparing this exact surface with a simultaneous manual reading. */
export interface VerifiedGrokPage {
  url: string;
  verifiedAt: string;
  referencePctUsed: number;
  referenceResetAt: string;
}

export interface GrokUsageOptions {
  verifiedPage?: VerifiedGrokPage;
  logPath?: string;
  now?: () => Date;
  readPage?: (url: string) => Promise<unknown>;
}

function usageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://grok.com' || url.username || url.password || url.hash) return null;
    if (url.pathname === '/' && url.search === '?_s=usage') return url.href;
    if (['/dashboard', '/settings/usage'].includes(url.pathname) && !url.search) return url.href;
  } catch { /* Untrusted location is never opened. */ }
  return null;
}

function fields(value: unknown): { pctUsed: number; resetAt: string } | null {
  if (!value || typeof value !== 'object') return null;
  const { pctUsed, resetAt } = value as Record<string, unknown>;
  if (typeof pctUsed !== 'number' || !Number.isFinite(pctUsed) || pctUsed < 0 || pctUsed > 100 ||
      typeof resetAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(resetAt) ||
      !Number.isFinite(Date.parse(resetAt))) return null;
  return { pctUsed, resetAt: new Date(resetAt).toISOString() };
}

/** Read only rendered usage elements. Never return page text, URLs, cookies or storage. */
export const GROK_USAGE_DOM_READ = `(() => {
  const panels = [...document.querySelectorAll('section, [role="region"]')].filter(e => {
    const t = e.innerText || '';
    return /grok ultra/i.test(t) && /weekly/i.test(t) && /cursor/i.test(t);
  });
  const values = panels.flatMap(e => {
    const matches = [...(e.innerText || '').matchAll(/(\\d+(?:\\.\\d+)?)\\s*%\\s*used\\b/gi)];
    const times = [...e.querySelectorAll('time[datetime]')];
    if (matches.length !== 1 || times.length !== 1) return [];
    return [{pctUsed: Number(matches[0][1]), resetAt: times[0].getAttribute('datetime')}];
  });
  return JSON.stringify(values.length === 1 ? values[0] : null);
})()`;

/** Existing Chrome tabs only: no navigation, login, network calls or browser profile access. */
export async function readGrokChromePage(url: string): Promise<unknown> {
  const location = usageUrl(url);
  if (process.platform !== 'darwin' || !location) return null;
  const script = `if application "Google Chrome" is not running then return "null"
  tell application "Google Chrome"
    repeat with w in windows
      repeat with t in tabs of w
        if URL of t is ${JSON.stringify(location)} then
          return execute t javascript ${JSON.stringify(GROK_USAGE_DOM_READ)}
        end if
      end repeat
    end repeat
    return "null"
  end tell`;
  return new Promise(resolve => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 8_000, maxBuffer: 1024 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

/** No verified surface or missing session means unknown, including in the log. */
export async function readGrokUsage(options: GrokUsageOptions = {}): Promise<GrokUsageReading> {
  const now = (options.now ?? (() => new Date()))();
  const reading: GrokUsageReading = {
    pool: 'grok-ultra', pctUsed: null, resetAt: null, source: 'grok-reader', fetchedAt: now.toISOString(),
  };
  const pin = options.verifiedPage;
  if (pin && usageUrl(pin.url) && fields({ pctUsed: pin.referencePctUsed, resetAt: pin.referenceResetAt }) &&
      Number.isFinite(Date.parse(pin.verifiedAt)) && Date.parse(pin.verifiedAt) <= now.getTime() &&
      Date.parse(pin.referenceResetAt) > now.getTime()) {
    try {
      const observed = fields(await (options.readPage ?? readGrokChromePage)(pin.url));
      if (observed && Date.parse(observed.resetAt) > now.getTime() &&
          Date.parse(observed.resetAt) === Date.parse(pin.referenceResetAt)) Object.assign(reading, observed);
    } catch { /* Provider/automation errors are unknown; never log their contents. */ }
  }
  if (options.logPath) {
    await appendFile(options.logPath, `${JSON.stringify({ ...reading, used: reading.pctUsed ?? 'unknown' })}\n`, { mode: 0o600 });
  }
  return reading;
}
