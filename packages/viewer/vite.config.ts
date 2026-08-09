import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    plugins: single ? [react(), viteSingleFile()] : [react()],
    base: './',
    build: {
      outDir: single ? 'dist-single' : 'dist',
      emptyOutDir: true,
      target: 'es2022',
    },
  };
});
