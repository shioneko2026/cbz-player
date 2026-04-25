import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    // 5173 (Vite default) sits inside Windows' reserved port range
    // 5103-5202 (often grabbed by Hyper-V / Docker Desktop), causing EACCES
    // on bind. 5210 is just outside the range and stays available.
    port: 5210,
  },
});
