// A physical CPU measurement must not compete with another test worker.
// Keep the complete file and its original five-second per-case bound.
export const SERIAL_CPU_TEST_FILES = Object.freeze([
  'test/memory-evaluation-performance.test.ts',
]);
