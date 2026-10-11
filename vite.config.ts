import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = import.meta.dirname;

/**
 * Dev-only endpoint so a phone can hand results back to the PC: POST JSON to /api/report/<name>
 * and it is appended as one line to .local/reports/<name>.jsonl (git-ignored).
 */
function reportSink(): Plugin {
  return {
    name: 'crosscue-report-sink',
    configureServer(server) {
      server.middlewares.use('/api/report/', (req, res) => {
        const name = (req.url ?? '').replace(/^\//, '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'report';
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
          if (body.length > 1_000_000) req.destroy();
        });
        req.on('end', () => {
          try {
            const line = JSON.stringify({ at: new Date().toISOString(), ...JSON.parse(body) });
            const dir = resolve(root, '.local/reports');
            mkdirSync(dir, { recursive: true });
            appendFileSync(resolve(dir, `${name}.jsonl`), line + '\n');
            res.statusCode = 204;
          } catch {
            res.statusCode = 400;
          }
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [reportSink()],
  server: { host: true, port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        sim: resolve(root, 'index.html'),
        xrcheck: resolve(root, 'src/live/xrcheck.html'),
        markers: resolve(root, 'src/live/markers.html'),
        observer: resolve(root, 'src/live/observer.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
