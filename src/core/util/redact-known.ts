/**
 * Known-value redaction for text that came back from an upstream service.
 *
 * scrubSecrets() matches known key SHAPES. A provider that echoes the key it
 * rejected ("Incorrect API key provided: <key>") can echo an opaque key with
 * no vendor prefix, which no shape rule catches. Here we redact the values we
 * actually sent: any run of MIN_RUN or more characters of a known secret is
 * replaced, so a whole echo and a partially masked echo are both covered.
 */

const MIN_RUN = 8;
const REDACTED = '[REDACTED]';

export function redactKnownValues(text: string, secrets: ReadonlyArray<string | null | undefined>): string {
  if (!text) return text;
  const windows = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== 'string') continue;
    const value = secret.trim();
    if (value.length < MIN_RUN) continue;
    for (let i = 0; i + MIN_RUN <= value.length; i += 1) windows.add(value.slice(i, i + MIN_RUN));
  }
  if (windows.size === 0) return text;
  const hit = new Uint8Array(text.length);
  let any = false;
  for (let i = 0; i + MIN_RUN <= text.length; i += 1) {
    if (windows.has(text.slice(i, i + MIN_RUN))) {
      hit.fill(1, i, i + MIN_RUN);
      any = true;
    }
  }
  if (!any) return text;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (hit[i]) {
      if (i === 0 || !hit[i - 1]) out += REDACTED;
    } else {
      out += text[i];
    }
  }
  return out;
}
