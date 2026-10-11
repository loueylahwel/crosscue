import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  server: { host: true, port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        sim: resolve(import.meta.dirname, 'index.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
