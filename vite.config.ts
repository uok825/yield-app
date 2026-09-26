import { defineConfig } from 'vite';

// The browser reaches the relayer through `/api` (works behind a tunnel); the relayer itself listens locally.
const proxy = {
  '/api': {
    // Docker: the web container points this at the relayer service.
    target: process.env.RELAYER_PROXY_TARGET ?? 'http://127.0.0.1:8080',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    allowedHosts: true,
    proxy,
  },
  preview: {
    host: true,
    allowedHosts: true,
    proxy,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
