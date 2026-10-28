import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// vitest.config.web.ts doesn't set `test.globals: true`, so
// @testing-library/react's own auto-cleanup (which detects a global
// `afterEach`) never registers. Do it explicitly so each test starts with
// an empty document instead of accumulating every previous test's render
// output in the same file.
afterEach(() => {
  cleanup();
});

// jsdom has no ResizeObserver; several primitives (command palette list
// virtualization guard, sticky headers) probe for it defensively. Stub a
// no-op so those code paths exercise their real branches under test instead
// of silently short-circuiting on `typeof ResizeObserver === 'undefined'`.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

// jsdom doesn't implement scrollIntoView; the command palette and keyboard
// nav call it when moving selection.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

// Node >= 25 exposes an inert experimental `localStorage` global that reads
// `undefined` unless the process is started with --localstorage-file. That
// stub is an own-property getter on globalThis, so it shadows jsdom's real
// Storage when vitest populates window globals and tests see `undefined`.
// Install a spec-shaped in-memory Storage only when the environment's
// localStorage is broken this way; a working jsdom Storage is left alone.
if (typeof globalThis.localStorage === 'undefined') {
  class MemoryStorage implements Storage {
    #entries = new Map<string, string>();
    get length(): number {
      return this.#entries.size;
    }
    clear(): void {
      this.#entries.clear();
    }
    getItem(key: string): string | null {
      return this.#entries.get(String(key)) ?? null;
    }
    key(index: number): string | null {
      return [...this.#entries.keys()][index] ?? null;
    }
    removeItem(key: string): void {
      this.#entries.delete(String(key));
    }
    setItem(key: string, value: string): void {
      this.#entries.set(String(key), String(value));
    }
  }
  delete (globalThis as { localStorage?: Storage }).localStorage;
  Object.defineProperty(globalThis, 'Storage', { value: MemoryStorage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true });
}
