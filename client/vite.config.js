import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// /api goes to the Express server. Its port comes from the repo-root .env (PORT), the same file the server reads.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  const apiPort = env.PORT || 3001;
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true } },
    },
  };
});
