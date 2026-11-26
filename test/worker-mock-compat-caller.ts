/** Exercise the compatibility wrapper from outside the setup directory. */
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

export async function mockAndRestoreIdentity() {
  // Use one absolute path because the wrapper's relative importer depends on
  // how the Node version formats the stack trace Vitest reads.
  const modulePath = fileURLToPath(new URL('./setup/fixtures/mock-compat-module.js', import.meta.url));
  const first = await import('./setup/fixtures/mock-compat-module.js');
  const mockIdentity = {};
  vi.doMock(modulePath, () => ({ identity: mockIdentity }));
  const mocked = await import('./setup/fixtures/mock-compat-module.js');
  vi.doUnmock(modulePath);
  const restored = await import('./setup/fixtures/mock-compat-module.js');
  return { first: first.identity, mockIdentity, mocked: mocked.identity, restored: restored.identity };
}
