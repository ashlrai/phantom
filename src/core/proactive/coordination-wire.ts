/** Typed digest references preserve public redaction without exempting arbitrary hex secrets. */
const DIGEST_FIELDS = new Set(['packetDigest', 'resultDigest', 'reportDigest', 'checkedResultDigest',
  'id', 'attemptId', 'reportId', 'eventId']);
export function companionDigestToReference(value: string): string {
  return /^[a-f0-9]{64}$/.test(value) ? `sha256:${value.match(/.{8}/g)!.join('.')}` : value;
}
export function companionDigestFromReference(value: string): string {
  return /^sha256:[a-f0-9]{8}(?:\.[a-f0-9]{8}){7}$/.test(value) ? value.slice(7).replaceAll('.', '') : value;
}
function transform(value: unknown, encode: boolean): unknown {
  if (Array.isArray(value)) return value.map(item => transform(item, encode));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key,
    DIGEST_FIELDS.has(key) && typeof field === 'string'
      ? (encode ? companionDigestToReference(field) : companionDigestFromReference(field))
      : transform(field, encode)]));
}
export function projectCompanionWire(value: unknown): unknown { return transform(value, true); }
export function decodeCompanionWire(value: unknown): unknown { return transform(value, false); }
