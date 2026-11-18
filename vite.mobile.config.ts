import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// MPI Remote (Android): the editor's renderer with the phone bridge and layout — built into dist/mobile for Capacitor.
export default defineConfig({
  root: 'src/mobile',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist/mobile', emptyOutDir: true, chunkSizeWarningLimit: 6000 },
});
