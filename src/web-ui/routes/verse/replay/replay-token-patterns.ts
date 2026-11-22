/**
 * Browser-only counterpart to core/util/scrub's token patterns. That module
 * imports node:os at module load and cannot run in Vite's browser dev runtime.
 * Keep this scoped here until the shared scrubber has a browser-safe entry.
 * Contextual keys/values are handled separately by replay-redaction.ts.
 */
export function scrubReplayTokens(text: string): string {
  return text
    .replace(/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?(?:-----END[ A-Z]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/(?:bot)?\d{6,12}:[A-Za-z0-9_-]{33,35}(?![A-Za-z0-9_-])/g, '[REDACTED]')
    .replace(/(https?:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)|(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks)\/)[A-Za-z0-9_/-]{8,}/gi, '$1[REDACTED]')
    .replace(/\bxai-[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/\b(?:cog_[A-Za-z0-9_-]{20,}|apk_(?:user_)?[A-Za-z0-9]{24,})/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\bgh[poursa]_[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+)*/g, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{22,}/g, '[REDACTED]')
    .replace(/\b(Bearer|Token|Authorization)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 [REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/gi, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\b[0-9a-fA-F]{64,}\b/g, '[REDACTED]')
    .replace(/\b(?:glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35})\b/g, '[REDACTED]')
    .replace(/(:\/\/[^:\s/@]*:)[^@\s]+(@)/g, '$1[REDACTED]$2')
    .replace(/(?<![/\w])[A-Za-z0-9+]{40,}={0,2}(?![/\w])/g, (value) => {
      if (/^[0-9a-fA-F]{40}$/.test(value) || /^(.)\1{39,}$/.test(value.replace(/^\+/, '').replace(/=+$/, ''))) return value;
      return '[REDACTED]';
    });
}
