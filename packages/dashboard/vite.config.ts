import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.BLAST_DASHBOARD_PORT ?? 5173),
    // In dev the dashboard runs on its own port and proxies to `blastradius
    // serve`. In production the API server serves the built bundle itself, so
    // the same relative /api paths work in both.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.BLAST_API_PORT ?? 4000}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
