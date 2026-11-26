/** Shared validation, path, durability and capability helpers for resource engineering modules. */
import { closeSync, constants, fsyncSync, lstatSync, openSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { ResourceSupervisorError } from './pool-supervisor.js';

const ENGINEERING_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENGINEERING_GRAPH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENGINEERING_HASH_RE = /^[a-f0-9]{64}$/;
const ENGINEERING_COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function isEngineeringId(value: unknown): value is string {
  return typeof value === 'string' && ENGINEERING_ID_RE.test(value);
}

export function isEngineeringGraphId(value: unknown): value is string {
  return typeof value === 'string' && ENGINEERING_GRAPH_ID_RE.test(value);
}

export function isEngineeringHash(value: unknown): value is string {
  return typeof value === 'string' && ENGINEERING_HASH_RE.test(value);
}

export function isEngineeringCommit(value: unknown): value is string {
  return typeof value === 'string' && ENGINEERING_COMMIT_RE.test(value);
}

export function isEngineeringIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function isEngineeringInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function isEngineeringObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasExactEngineeringKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isEngineeringObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function hasExactEngineeringOwnKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isEngineeringObject(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function isBoundedEngineeringText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= maxBytes &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127) || code >= 160;
    });
}

export function isCanonicalAbsoluteNonRootPath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === value && parse(value).root !== value;
}

function hasControlChars(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

export function isCanonicalEngineeringPath(value: unknown): value is string {
  return isCanonicalAbsoluteNonRootPath(value) && Buffer.byteLength(value) <= 4096 && !hasControlChars(value);
}

export function isCanonicalEngineeringCharPath(value: unknown): value is string {
  return isCanonicalAbsoluteNonRootPath(value) && value.length <= 4096 && !hasControlChars(value);
}

export function engineeringDigest(value: unknown): string {
  return digest(canonical(value));
}

export function cloneCanonicalEngineeringData<T>(
  input: unknown,
  maxBytes: number,
  onInvalid: () => never,
): T {
  const serialized = canonicalEvidencePackJsonV3(input);
  if (serialized === null || Buffer.byteLength(serialized) > maxBytes) onInvalid();
  return JSON.parse(serialized) as T;
}

export function containsPath(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

export function pathsOverlap(a: string, b: string): boolean {
  return containsPath(a, b) || containsPath(b, a);
}

export function pathExistsStrict(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function writeExclusivePrivateJson(filePath: string, value: unknown): void {
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, canonical(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(filePath));
}

export function failResourceSupervisor(
  code: ConstructorParameters<typeof ResourceSupervisorError>[0],
  message: string,
): never {
  throw new ResourceSupervisorError(code, message);
}

export function bindOwnDataMethod<T extends object, K extends keyof T>(
  target: T,
  key: K,
  onInvalid: () => never,
): T[K] {
  const property = target && Object.getOwnPropertyDescriptor(target, key);
  if (!property || !Object.hasOwn(property, 'value') || typeof property.value !== 'function') onInvalid();
  return property.value.bind(target) as T[K];
}

export function captureStrictOwnDataOptions<T extends object>(
  input: T,
  required: readonly string[],
  optional: readonly string[],
  onInvalid: () => never,
  requirePlainPrototype = true,
): T {
  if (!input || typeof input !== 'object' || Array.isArray(input)) onInvalid();
  if (requirePlainPrototype) {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) onInvalid();
  }
  const allowed = new Set([...required, ...optional]);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      required.some((key) => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) {
    onInvalid();
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as T;
}

export function resolveTsxWorkerEntrypoint(callerUrl: string, callerTsSuffix: string, workerBaseName: string): URL {
  if (callerUrl.endsWith(callerTsSuffix)) {
    const loader = pathToFileURL(createRequire(callerUrl).resolve('tsx/esm/api')).href;
    const source = new URL(`./${workerBaseName}.ts`, callerUrl).href;
    return new URL(`data:text/javascript,${encodeURIComponent(`import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`)}`);
  }
  return new URL(`./${workerBaseName}.js`, callerUrl);
}
