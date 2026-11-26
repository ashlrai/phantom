/** Browser-safe pure validation and canonical-JSON primitives shared across proactive modules. */

const SHA256_HEX = /^[a-f0-9]{64}$/;
const PROACTIVE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

export interface PlainDataObjectOptions { maxKeys?: number; requireEnumerable?: boolean }
export interface DenseDataArrayOptions { exactPrototype?: boolean }
export interface ControlCharOptions { allowMultiline?: boolean; rejectC1?: boolean }

export function compareLex(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}
export function isCanonicalIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function hasNoControlChars(value: string, options?: ControlCharOptions): boolean {
  const allowMultiline = options?.allowMultiline === true;
  const rejectC1 = options?.rejectC1 === true;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32) {
      if (!allowMultiline || (code !== 9 && code !== 10 && code !== 13)) return false;
    } else if (code === 127 || (rejectC1 && code > 127 && code <= 159)) {
      return false;
    }
  }
  return true;
}
export function isProactiveSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && PROACTIVE_SLUG.test(value);
}
export function isNonNegativeDecimal(value: unknown, maxLength = 64): value is string {
  return typeof value === 'string' && value.length <= maxLength && NON_NEGATIVE_DECIMAL.test(value);
}
export function isUniqueStringList(
  value: unknown,
  maxLength: number,
  itemValid: (item: unknown) => item is string,
): value is string[] {
  return Array.isArray(value) && value.length <= maxLength && value.every(itemValid) && new Set(value).size === value.length;
}
/** Strict plain-object check: Object/null prototype and own string data properties only (no getters/symbols). */
export function isPlainDataObject(value: unknown, options?: PlainDataObjectOptions): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (options?.maxKeys !== undefined && keys.length > options.maxKeys) return false;
  return keys.every(key => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && Object.hasOwn(descriptor, 'value') && (!options?.requireEnumerable || !!descriptor.enumerable);
  });
}
/** Strict plain-object check requiring every `required` key and permitting only `required` + `optional` keys. */
export function hasPlainDataKeys(
  value: unknown, required: readonly string[], optional: readonly string[] = [],
  options?: Pick<PlainDataObjectOptions, 'requireEnumerable'>,
): value is Record<string, unknown> {
  if (!isPlainDataObject(value, options)) return false;
  const allowed = new Set([...required, ...optional]);
  return (Reflect.ownKeys(value) as string[]).every(key => allowed.has(key)) && required.every(key => Object.hasOwn(value, key));
}
/** Strict dense-array check: bounded length, no sparse holes, no getters, no extra own properties. */
export function isDenseDataArray(value: unknown, maxLength: number, options?: DenseDataArrayOptions): value is unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) return false;
  if (options?.exactPrototype && Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
}
/** Deterministic key-sorted JSON serialization for local digest and equality checks. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => compareLex(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}
