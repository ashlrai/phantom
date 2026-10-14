import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Synthetic fixture only: no app API proxy, environment loading or production server.
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  envDir: false,
  plugins: [react()],
  server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [fileURLToPath(new URL('../../../', import.meta.url))] } },
  build: { outDir: '../../../.tmp/hint-browser-fixture-build', emptyOutDir: true },
});
