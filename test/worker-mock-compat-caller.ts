/** Mock isolation witness outside the setup directory. */
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

export async function mockAndRestoreIdentity() {
  const first = await import('./setup/fixtures/mock-compat-module.js');
  const mockIdentity = {};
  const fixture = fileURLToPath(new URL('./setup/fixtures/mock-compat-module.js', import.meta.url));
  vi.doMock(fixture, () => ({ identity: mockIdentity }));
  const mocked = await import('./setup/fixtures/mock-compat-module.js');
  vi.doUnmock(fixture);
  const restored = await import('./setup/fixtures/mock-compat-module.js');
  return { first: first.identity, mockIdentity, mocked: mocked.identity, restored: restored.identity };
}
