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

// Node >=25 ships an experimental `localStorage`/`sessionStorage` global that
// resolves to undefined unless --localstorage-file is passed. Vitest's jsdom
// environment skips populating any key Node already owns, so that inert stub
// reaches tests instead of jsdom's real Storage. Re-point both globals at the
// JSDOM instance's own storage — a no-op wherever the Node stub is absent.
const jsdomWindow = (globalThis as { jsdom?: { window?: Pick<Window, 'localStorage' | 'sessionStorage'> } }).jsdom?.window;
for (const key of ['localStorage', 'sessionStorage'] as const) {
  if (jsdomWindow && typeof globalThis[key] === 'undefined' && typeof jsdomWindow[key] !== 'undefined') {
    Object.defineProperty(globalThis, key, {
      get: () => jsdomWindow[key],
      configurable: true,
    });
  }
}
